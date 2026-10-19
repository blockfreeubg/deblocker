import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { AccessControl, AttemptLimiter } from "./access.js";
import { toPublicConfig, type ServerConfig } from "./config.js";
import { createEngineHandler, locateEngineFiles } from "./engine.js";
import type { Logger } from "./logger.js";
import { DestinationPolicy } from "./policy.js";
import { configureWisp, WispGateway } from "./wisp.js";
import type { SessionState } from "../shared/public-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");

export function readAppVersion(): string {
	try {
		return (JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version: string }).version;
	} catch {
		return "unknown";
	}
}

export interface DeblockerApp {
	app: express.Express;
	gateway: WispGateway;
	/** Pre-compresses the engine bundles; safe to ignore the returned promise. */
	warm: () => Promise<void>;
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("X-Frame-Options", "SAMEORIGIN");
	res.setHeader("Content-Security-Policy", "frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
	next();
}

/** Rejects state-changing API calls that come from another site. */
function sameOriginOnly(req: Request, res: Response, next: NextFunction) {
	const origin = req.headers.origin;
	if (origin) {
		try {
			if (new URL(origin).host === req.headers.host) return next();
		} catch {
			// fall through
		}
		res.status(403).json({ error: "Cross-site requests are not allowed." });
		return;
	}
	next();
}

export interface CreateAppOptions {
	/** Serve the built frontend (or Vite in dev). Tests that only exercise the API and Wisp turn this off. */
	frontend?: boolean;
}

export async function createApp(config: ServerConfig, logger: Logger, httpServer?: Server, options: CreateAppOptions = {}): Promise<DeblockerApp> {
	const frontend = options.frontend ?? true;
	const version = readAppVersion();
	const engine = locateEngineFiles(config);
	const engineHandler = createEngineHandler(engine, logger);
	const policy = new DestinationPolicy(config.destinations);
	const access = new AccessControl({ ...config.access, cookiePath: config.basePath });
	const unlockLimiter = new AttemptLimiter(10, 15 * 60 * 1000);
	const publicConfig = toPublicConfig(config, version, engine.versions);

	configureWisp(config, policy, logger);
	const gateway = new WispGateway({ config, access, logger });

	const app = express();
	app.disable("x-powered-by");
	app.set("trust proxy", config.trustProxy);
	app.set("etag", "strong");

	const base = config.basePath;
	if (base !== "/") {
		const bare = base.slice(0, -1);
		app.use((req, res, next) => {
			const [pathname, query] = req.originalUrl.split(/\?(.*)/s, 2);
			if (pathname === bare) return res.redirect(301, `${base}${query ? `?${query}` : ""}`);
			if (pathname === "/" && req.method === "GET") return res.redirect(302, base);
			next();
		});
	}

	const router = express.Router({ caseSensitive: true, strict: true });
	router.use(securityHeaders);

	router.get("/api/health", (_req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.json({ status: "ok", version });
	});

	router.get("/api/config", (_req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.json(publicConfig);
	});

	router.get("/api/session", (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		const state: SessionState = { required: access.required, authenticated: access.isAuthenticated(req.headers.cookie) };
		res.json(state);
	});

	router.post("/api/session", sameOriginOnly, express.json({ limit: "4kb" }), (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!access.required) {
			res.json({ required: false, authenticated: true } satisfies SessionState);
			return;
		}
		const ip = req.ip ?? "unknown";
		if (!unlockLimiter.attempt(ip)) {
			res.setHeader("Retry-After", String(unlockLimiter.retryAfterSeconds(ip)));
			res.status(429).json({ error: "Too many attempts. Try again later." });
			return;
		}
		const key = (req.body as { key?: unknown } | undefined)?.key;
		if (!access.verifyKey(key)) {
			logger.warn(`Rejected access key attempt from ${ip}`);
			res.status(401).json({ error: "That access key isn't right." });
			return;
		}
		res.setHeader("Set-Cookie", access.sessionCookie(req.secure));
		res.json({ required: true, authenticated: true } satisfies SessionState);
	});

	router.delete("/api/session", sameOriginOnly, (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Set-Cookie", access.clearedCookie(req.secure));
		res.json({ required: access.required, authenticated: !access.required } satisfies SessionState);
	});

	// Lets the interface explain a failed load accurately: the transport reports a refused destination
	// the same way as an unreachable one. Checks the hostname rules only (no DNS lookup).
	router.get("/api/policy", (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		let url: URL;
		try {
			url = new URL(String(req.query.url ?? ""));
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
		} catch {
			res.status(400).json({ error: "Expected an http(s) URL in ?url=" });
			return;
		}
		const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		const decision = policy.check(url.hostname, port);
		res.json(decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason });
	});

	router.all(/^\/api\//, (_req, res) => {
		res.status(404).json({ error: "Not found" });
	});

	router.get("/engine/:file", engineHandler.handler);

	if (frontend && !config.dev) {
		const publicDir = path.join(projectRoot, "dist", "public");
		const indexFile = path.join(publicDir, "index.html");
		if (!existsSync(indexFile)) {
			throw new Error(`The frontend has not been built (missing ${indexFile}). Run "npm run build" first, or use "npm run dev".`);
		}
		const sendIndex = (_req: Request, res: Response) => {
			res.setHeader("Cache-Control", "no-cache");
			res.sendFile(indexFile);
		};
		router.get("/", sendIndex);
		router.get("/index.html", sendIndex);
		router.use(
			express.static(publicDir, {
				index: false,
				redirect: false,
				setHeaders(res, filePath) {
					const relative = path.relative(publicDir, filePath);
					if (relative.startsWith(`assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
					else res.setHeader("Cache-Control", "no-cache");
					if (relative === "sw.js") res.setHeader("Service-Worker-Allowed", base);
				},
			}),
		);
	}

	app.use(base === "/" ? "/" : base.slice(0, -1), router);

	if (frontend && config.dev) {
		const { createServer } = await import("vite");
		const vite = await createServer({
			configFile: path.join(projectRoot, "vite.config.ts"),
			base,
			appType: "spa",
			server: { middlewareMode: true, hmr: httpServer ? { server: httpServer } : true },
		});
		app.use(vite.middlewares);
		logger.info("Development mode: serving the frontend through Vite with hot reload");
	}

	app.use((req, res) => {
		res.status(404).type("text/plain").send(`Not found. Deblocker is served at ${base}`);
	});

	app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
		const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 500;
		if (status >= 500) logger.error("Unhandled request error:", error);
		if (!res.headersSent) res.status(Number.isInteger(status) && status >= 400 ? status : 500).json({ error: status >= 500 ? "Internal server error" : "Bad request" });
	});

	return { app, gateway, warm: engineHandler.warm };
}
