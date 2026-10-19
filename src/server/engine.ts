import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import type { Request, Response } from "express";
import type { ServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { PublicConfig, TransportName } from "../shared/public-config.js";

const require = createRequire(import.meta.url);
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Walks up from a resolved entry point to the package.json of the package that owns it. */
function packageRootOf(entry: string): string {
	let dir = path.dirname(entry);
	while (dir !== path.dirname(dir)) {
		if (existsSync(path.join(dir, "package.json"))) return dir;
		dir = path.dirname(dir);
	}
	throw new Error(`Could not find package.json above ${entry}`);
}

function versionOf(root: string): string {
	return (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
}

const TRANSPORT_PACKAGES: Record<TransportName, string> = {
	libcurl: "@mercuryworkshop/libcurl-transport",
	epoxy: "@mercuryworkshop/epoxy-transport",
};

export interface EngineFiles {
	/** Public file name (served under <base>engine/) -> absolute path on disk. */
	files: Map<string, string>;
	versions: PublicConfig["engine"];
}

/**
 * Locates the prebuilt Scramjet, Scramjet Controller and transport bundles inside node_modules
 * (or in directories given by SCRAMJET_DIST_DIR / SCRAMJET_CONTROLLER_DIST_DIR for custom builds).
 */
export function locateEngineFiles(config: ServerConfig): EngineFiles {
	const scramjetRoot = packageRootOf(require.resolve("@mercuryworkshop/scramjet/path"));
	const scramjetDist = config.scramjetDistDir ?? path.join(scramjetRoot, "dist");
	const controllerRoot = packageRootOf(require.resolve("@mercuryworkshop/scramjet-controller"));
	const controllerDist = config.controllerDistDir ?? path.join(controllerRoot, "dist");
	const utilsRoot = packageRootOf(require.resolve("@mercuryworkshop/scramjet-utils"));
	const transportEntry = require.resolve(TRANSPORT_PACKAGES[config.transport]);
	const transportRoot = packageRootOf(transportEntry);

	const files = new Map<string, string>([
		["scramjet.js", path.join(scramjetDist, "scramjet.js")],
		["scramjet.js.map", path.join(scramjetDist, "scramjet.js.map")],
		["scramjet.wasm", path.join(scramjetDist, "scramjet.wasm")],
		["controller.api.js", path.join(controllerDist, "controller.api.js")],
		["controller.api.js.map", path.join(controllerDist, "controller.api.js.map")],
		["controller.inject.js", path.join(controllerDist, "controller.inject.js")],
		["controller.inject.js.map", path.join(controllerDist, "controller.inject.js.map")],
		["controller.sw.js", path.join(controllerDist, "controller.sw.js")],
		["controller.sw.js.map", path.join(controllerDist, "controller.sw.js.map")],
		["scramjet-utils.js", path.join(utilsRoot, "dist", "scramjet-utils.js")],
		["scramjet-utils.js.map", path.join(utilsRoot, "dist", "scramjet-utils.js.map")],
		["transport.js", path.join(transportRoot, "dist", "index.js")],
	]);

	const required = ["scramjet.js", "scramjet.wasm", "controller.api.js", "controller.inject.js", "controller.sw.js", "scramjet-utils.js", "transport.js"];
	const missing = required.filter((name) => !existsSync(files.get(name)!));
	if (missing.length > 0) {
		throw new Error(`Scramjet engine files are missing: ${missing.map((name) => files.get(name)).join(", ")}. Run "npm install" (or check SCRAMJET_DIST_DIR).`);
	}
	for (const [name, file] of files) if (!existsSync(file)) files.delete(name);

	return {
		files,
		versions: {
			scramjet: config.scramjetDistDir ? "custom build" : versionOf(scramjetRoot),
			controller: config.controllerDistDir ? "custom build" : versionOf(controllerRoot),
			transport: `${config.transport} ${versionOf(transportRoot)}`,
		},
	};
}

interface CachedFile {
	raw: Buffer;
	etag: string;
	br?: Promise<Buffer>;
	gzip?: Promise<Buffer>;
}

function contentType(name: string): string {
	if (name.endsWith(".wasm")) return "application/wasm";
	if (name.endsWith(".map")) return "application/json; charset=utf-8";
	return "text/javascript; charset=utf-8";
}

/** Serves engine files from memory with ETags and Brotli/gzip compression (the bundles are several MB). */
export function createEngineHandler(engine: EngineFiles, logger: Logger) {
	const cache = new Map<string, Promise<CachedFile>>();

	const load = (name: string, file: string): Promise<CachedFile> => {
		let entry = cache.get(name);
		if (!entry) {
			entry = readFile(file).then((raw) => ({ raw, etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 27)}"` }));
			entry.catch(() => cache.delete(name));
			cache.set(name, entry);
		}
		return entry;
	};

	const compressed = (cached: CachedFile, encoding: "br" | "gzip"): Promise<Buffer> => {
		if (encoding === "br") {
			cached.br ??= brotli(cached.raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 7 } });
			return cached.br;
		}
		cached.gzip ??= gzipAsync(cached.raw, { level: 7 });
		return cached.gzip;
	};

	const handler = async (req: Request, res: Response) => {
		const name = String(req.params.file ?? "");
		const file = engine.files.get(name);
		if (!file) {
			res.status(404).type("text/plain").send("Not found");
			return;
		}
		try {
			const cached = await load(name, file);
			res.setHeader("Content-Type", contentType(name));
			res.setHeader("Cache-Control", "no-cache");
			res.setHeader("ETag", cached.etag);
			res.setHeader("Vary", "Accept-Encoding");
			res.setHeader("X-Content-Type-Options", "nosniff");
			if (req.headers["if-none-match"] === cached.etag) {
				res.status(304).end();
				return;
			}
			const accepted = String(req.headers["accept-encoding"] ?? "");
			const encoding = /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : null;
			const body = encoding ? await compressed(cached, encoding) : cached.raw;
			if (encoding) res.setHeader("Content-Encoding", encoding);
			res.setHeader("Content-Length", body.length);
			res.status(200).end(req.method === "HEAD" ? undefined : body);
		} catch (error) {
			logger.error(`Failed to serve engine file ${name}:`, error);
			if (!res.headersSent) res.status(500).type("text/plain").send("Failed to read engine file");
		}
	};

	/** Reads and compresses everything up front so the first visitor doesn't wait. */
	const warm = async () => {
		await Promise.all(
			[...engine.files].filter(([name]) => !name.endsWith(".map")).map(async ([name, file]) => {
				const cached = await load(name, file);
				await Promise.all([compressed(cached, "br"), compressed(cached, "gzip")]);
			}),
		);
	};

	return { handler, warm };
}
