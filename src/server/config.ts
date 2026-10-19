import { SEARCH_ENGINES, type PublicConfig, type QuickLink, type TransportName } from "../shared/public-config.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface ServerConfig {
	/** Port the HTTP server listens on. */
	port: number;
	/** Interface to bind. */
	host: string;
	/** URL path the app is mounted under, always with leading and trailing slash ("/" or "/deblocker/"). */
	basePath: string;
	/** Value handed to Express' "trust proxy" setting; also used for WebSocket client IPs. */
	trustProxy: boolean | number | string[];
	dev: boolean;
	logLevel: LogLevel;

	transport: TransportName;
	scramjetDistDir: string | null;
	controllerDistDir: string | null;

	destinations: DestinationConfig;
	limits: {
		maxConnectionsPerIp: number;
		maxStreamsPerConnection: number;
	};

	access: {
		/** Optional shared key that visitors must enter before the proxy backend accepts them. */
		key: string | null;
		/** HMAC secret for session cookies. Random per process when not configured. */
		sessionSecret: string | null;
		sessionTtlSeconds: number;
	};
	/** Extra origins (besides the request's own host) allowed to open the Wisp WebSocket. */
	allowedOrigins: string[];

	ui: {
		searchEngine: string;
		quickLinks: QuickLink[];
	};
}

export interface DestinationConfig {
	/** Allowed destination ports, or "any". */
	ports: number[] | "any";
	/** Permit loopback, private, link-local and other non-public addresses (development only). */
	allowPrivate: boolean;
	/** When non-empty, only these hosts (and their subdomains) may be reached. */
	allowlist: string[];
	/** Hosts (and their subdomains) that may never be reached. */
	blocklist: string[];
}

export class ConfigError extends Error {
	constructor(public readonly problems: string[]) {
		super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
		this.name = "ConfigError";
	}
}

export const DEFAULT_QUICK_LINKS: QuickLink[] = [
	{ title: "Wikipedia", url: "https://www.wikipedia.org/" },
	{ title: "DuckDuckGo", url: "https://duckduckgo.com/" },
	{ title: "GitHub", url: "https://github.com/" },
	{ title: "MDN Web Docs", url: "https://developer.mozilla.org/" },
	{ title: "Hacker News", url: "https://news.ycombinator.com/" },
	{ title: "Internet Archive", url: "https://archive.org/" },
];

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env, argv: string[] = process.argv): ServerConfig {
	const problems: string[] = [];
	const read = (name: string): string | undefined => {
		const value = env[name]?.trim();
		return value === "" ? undefined : value;
	};

	const int = (name: string, fallback: number, min: number, max: number): number => {
		const raw = read(name);
		if (raw === undefined) return fallback;
		const value = Number(raw);
		if (!Number.isInteger(value) || value < min || value > max) {
			problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
			return fallback;
		}
		return value;
	};

	const bool = (name: string, fallback: boolean): boolean => {
		const raw = read(name)?.toLowerCase();
		if (raw === undefined) return fallback;
		if (["1", "true", "yes", "on"].includes(raw)) return true;
		if (["0", "false", "no", "off"].includes(raw)) return false;
		problems.push(`${name} must be true or false (got "${raw}")`);
		return fallback;
	};

	const list = (name: string): string[] =>
		(read(name) ?? "")
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);

	const dev = argv.includes("--dev") || read("NODE_ENV") === "development";

	const basePath = normalizeBasePath(read("BASE_PATH") ?? "/", problems);

	const transportRaw = (read("TRANSPORT") ?? "libcurl").toLowerCase();
	let transport: TransportName = "libcurl";
	if (transportRaw === "libcurl" || transportRaw === "epoxy") transport = transportRaw;
	else problems.push(`TRANSPORT must be "libcurl" or "epoxy" (got "${transportRaw}")`);

	const logRaw = (read("LOG_LEVEL") ?? "info").toLowerCase();
	let logLevel: LogLevel = "info";
	if (logRaw === "error" || logRaw === "warn" || logRaw === "info" || logRaw === "debug") logLevel = logRaw;
	else problems.push(`LOG_LEVEL must be one of error, warn, info, debug (got "${logRaw}")`);

	const destinations: DestinationConfig = {
		ports: parsePorts(read("ALLOWED_PORTS") ?? "80,443", problems),
		allowPrivate: bool("ALLOW_PRIVATE_DESTINATIONS", false),
		allowlist: parseHostList("DESTINATION_ALLOWLIST", list("DESTINATION_ALLOWLIST"), problems),
		blocklist: parseHostList("DESTINATION_BLOCKLIST", list("DESTINATION_BLOCKLIST"), problems),
	};

	const accessKey = read("ACCESS_KEY") ?? null;
	if (accessKey !== null && accessKey.length < 8) {
		problems.push("ACCESS_KEY must be at least 8 characters long");
	}
	const sessionSecret = read("SESSION_SECRET") ?? null;
	if (sessionSecret !== null && sessionSecret.length < 32) {
		problems.push("SESSION_SECRET must be at least 32 characters long");
	}

	const allowedOrigins: string[] = [];
	for (const origin of list("ALLOWED_ORIGINS")) {
		try {
			const parsed = new URL(origin);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad scheme");
			allowedOrigins.push(parsed.origin);
		} catch {
			problems.push(`ALLOWED_ORIGINS contains an invalid origin: "${origin}" (expected e.g. https://proxy.example.com)`);
		}
	}

	const searchEngine = parseSearchEngine(read("DEFAULT_SEARCH_ENGINE") ?? "duckduckgo", problems);
	const quickLinksRaw = read("DEFAULT_QUICK_LINKS");
	const quickLinks = quickLinksRaw === undefined ? DEFAULT_QUICK_LINKS : parseQuickLinks(quickLinksRaw, problems);

	const config: ServerConfig = {
		port: int("PORT", 8080, 1, 65535),
		host: read("HOST") ?? "0.0.0.0",
		basePath,
		trustProxy: parseTrustProxy(read("TRUST_PROXY"), problems),
		dev,
		logLevel,
		transport,
		scramjetDistDir: read("SCRAMJET_DIST_DIR") ?? null,
		controllerDistDir: read("SCRAMJET_CONTROLLER_DIST_DIR") ?? null,
		destinations,
		limits: {
			maxConnectionsPerIp: int("MAX_CONNECTIONS_PER_IP", 24, 1, 10_000),
			maxStreamsPerConnection: int("MAX_STREAMS_PER_CONNECTION", 128, 1, 100_000),
		},
		access: {
			key: accessKey,
			sessionSecret,
			sessionTtlSeconds: int("SESSION_TTL_HOURS", 24 * 7, 1, 24 * 365) * 3600,
		},
		allowedOrigins,
		ui: { searchEngine, quickLinks },
	};

	if (problems.length > 0) throw new ConfigError(problems);
	return config;
}

export function normalizeBasePath(raw: string, problems: string[] = []): string {
	let value = raw.trim();
	if (!value.startsWith("/")) value = `/${value}`;
	if (!value.endsWith("/")) value = `${value}/`;
	value = value.replace(/\/{2,}/g, "/");
	if (!/^\/([A-Za-z0-9._~-]+\/)*$/.test(value) || value.split("/").some((segment) => segment === "." || segment === "..")) {
		problems.push(`BASE_PATH must be a plain URL path such as "/" or "/deblocker" (got "${raw}")`);
		return "/";
	}
	return value;
}

function parsePorts(raw: string, problems: string[]): number[] | "any" {
	if (raw.trim() === "*") return "any";
	const ports = new Set<number>();
	let invalid = false;
	for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
		const range = /^(\d+)-(\d+)$/.exec(part);
		const [start, end] = range ? [Number(range[1]), Number(range[2])] : [Number(part), Number(part)];
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end || end - start > 10_000) {
			problems.push(`ALLOWED_PORTS contains an invalid port or range: "${part}"`);
			invalid = true;
			continue;
		}
		for (let port = start; port <= end; port++) ports.add(port);
	}
	if (ports.size === 0 && !invalid) problems.push('ALLOWED_PORTS must list at least one port (or "*")');
	return [...ports].sort((a, b) => a - b);
}

const HOST_PATTERN = /^(\*\.)?(?=.{1,253}$)([a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$/;

function parseHostList(name: string, entries: string[], problems: string[]): string[] {
	const hosts: string[] = [];
	for (const entry of entries) {
		const host = entry.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
		if (!HOST_PATTERN.test(host)) {
			problems.push(`${name} contains an invalid hostname: "${entry}"`);
			continue;
		}
		hosts.push(host);
	}
	return hosts;
}

function parseTrustProxy(raw: string | undefined, problems: string[]): boolean | number | string[] {
	if (raw === undefined) return false;
	const lower = raw.toLowerCase();
	if (lower === "false" || lower === "0") return false;
	if (lower === "true") return true;
	if (/^\d+$/.test(raw)) return Number(raw);
	const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
	if (entries.length === 0) {
		problems.push(`TRUST_PROXY is invalid: "${raw}"`);
		return false;
	}
	return entries;
}

function parseSearchEngine(raw: string, problems: string[]): string {
	const known = SEARCH_ENGINES.find((engine) => engine.id === raw.toLowerCase());
	if (known) return known.template;
	if (!raw.includes("%s")) {
		problems.push(`DEFAULT_SEARCH_ENGINE must be one of ${SEARCH_ENGINES.map((e) => e.id).join(", ")} or a URL containing %s`);
		return SEARCH_ENGINES[0]!.template;
	}
	try {
		const url = new URL(raw.replace("%s", "test"));
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
	} catch {
		problems.push(`DEFAULT_SEARCH_ENGINE is not a valid http(s) URL template: "${raw}"`);
		return SEARCH_ENGINES[0]!.template;
	}
	return raw;
}

function parseQuickLinks(raw: string, problems: string[]): QuickLink[] {
	const links: QuickLink[] = [];
	for (const item of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
		const separator = item.indexOf("|");
		const title = separator > 0 ? item.slice(0, separator).trim() : "";
		const url = separator > 0 ? item.slice(separator + 1).trim() : "";
		try {
			const parsed = new URL(url);
			if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !title) throw new Error("invalid");
			links.push({ title: title.slice(0, 40), url: parsed.href });
		} catch {
			problems.push(`DEFAULT_QUICK_LINKS entry must look like "Title|https://example.com" (got "${item}")`);
		}
	}
	return links.slice(0, 24);
}

export function toPublicConfig(config: ServerConfig, version: string, engine: PublicConfig["engine"]): PublicConfig {
	return {
		version,
		transport: config.transport,
		accessKeyRequired: config.access.key !== null,
		searchEngine: config.ui.searchEngine,
		quickLinks: config.ui.quickLinks,
		engine,
		policy: {
			ports: config.destinations.ports,
			allowlistActive: config.destinations.allowlist.length > 0,
			privateDestinations: config.destinations.allowPrivate,
		},
	};
}
