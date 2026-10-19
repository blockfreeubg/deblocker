import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_QUICK_LINKS, loadConfig, normalizeBasePath, toPublicConfig } from "../../src/server/config.js";

const load = (env: Record<string, string>) => loadConfig(env, []);

describe("loadConfig", () => {
	it("has safe defaults", () => {
		const config = load({});
		expect(config.port).toBe(8080);
		expect(config.host).toBe("0.0.0.0");
		expect(config.basePath).toBe("/");
		expect(config.transport).toBe("libcurl");
		expect(config.destinations).toEqual({ ports: [80, 443], allowPrivate: false, allowlist: [], blocklist: [] });
		expect(config.access.key).toBeNull();
		expect(config.trustProxy).toBe(false);
		expect(config.ui.searchEngine).toBe("https://duckduckgo.com/?q=%s");
		expect(config.ui.quickLinks).toEqual(DEFAULT_QUICK_LINKS);
		expect(config.dev).toBe(false);
	});

	it("parses every supported variable", () => {
		const config = load({
			PORT: "3000",
			HOST: "127.0.0.1",
			BASE_PATH: "deblocker",
			TRUST_PROXY: "loopback, uniquelocal",
			TRANSPORT: "EPOXY",
			LOG_LEVEL: "debug",
			ALLOWED_PORTS: "443, 8000-8002",
			ALLOW_PRIVATE_DESTINATIONS: "yes",
			DESTINATION_ALLOWLIST: "*.Wikipedia.org, wikimedia.org",
			DESTINATION_BLOCKLIST: "ads.example",
			MAX_CONNECTIONS_PER_IP: "5",
			MAX_STREAMS_PER_CONNECTION: "64",
			ACCESS_KEY: "supersecret",
			SESSION_SECRET: "s".repeat(40),
			SESSION_TTL_HOURS: "2",
			ALLOWED_ORIGINS: "https://proxy.example.com/, http://localhost:5173",
			DEFAULT_SEARCH_ENGINE: "brave",
			DEFAULT_QUICK_LINKS: "Docs|https://docs.example.com, Wiki|https://wiki.example.com/x",
		});
		expect(config.port).toBe(3000);
		expect(config.host).toBe("127.0.0.1");
		expect(config.basePath).toBe("/deblocker/");
		expect(config.trustProxy).toEqual(["loopback", "uniquelocal"]);
		expect(config.transport).toBe("epoxy");
		expect(config.logLevel).toBe("debug");
		expect(config.destinations.ports).toEqual([443, 8000, 8001, 8002]);
		expect(config.destinations.allowPrivate).toBe(true);
		expect(config.destinations.allowlist).toEqual(["wikipedia.org", "wikimedia.org"]);
		expect(config.destinations.blocklist).toEqual(["ads.example"]);
		expect(config.limits).toEqual({ maxConnectionsPerIp: 5, maxStreamsPerConnection: 64 });
		expect(config.access).toEqual({ key: "supersecret", sessionSecret: "s".repeat(40), sessionTtlSeconds: 7200 });
		expect(config.allowedOrigins).toEqual(["https://proxy.example.com", "http://localhost:5173"]);
		expect(config.ui.searchEngine).toBe("https://search.brave.com/search?q=%s");
		expect(config.ui.quickLinks).toEqual([
			{ title: "Docs", url: "https://docs.example.com/" },
			{ title: "Wiki", url: "https://wiki.example.com/x" },
		]);
	});

	it("accepts any port with *", () => {
		expect(load({ ALLOWED_PORTS: "*" }).destinations.ports).toBe("any");
	});

	it("accepts custom search templates", () => {
		expect(load({ DEFAULT_SEARCH_ENGINE: "https://search.example/?q=%s" }).ui.searchEngine).toBe("https://search.example/?q=%s");
	});

	it("reports every invalid value at once", () => {
		let error: unknown;
		try {
			load({
				PORT: "99999",
				BASE_PATH: "/a/../b",
				TRANSPORT: "bare",
				ALLOWED_PORTS: "0",
				ACCESS_KEY: "short",
				SESSION_SECRET: "tiny",
				ALLOWED_ORIGINS: "ftp://x",
				DEFAULT_SEARCH_ENGINE: "nope",
				DEFAULT_QUICK_LINKS: "broken",
				DESTINATION_BLOCKLIST: "bad host!",
				ALLOW_PRIVATE_DESTINATIONS: "maybe",
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).problems).toHaveLength(11);
	});

	it("enables dev mode from the CLI flag", () => {
		expect(loadConfig({}, ["node", "index.ts", "--dev"]).dev).toBe(true);
	});

	it("listens only on loopback in dev mode or with private destinations, unless HOST is set", () => {
		expect(loadConfig({}, ["--dev"]).host).toBe("127.0.0.1");
		expect(load({ ALLOW_PRIVATE_DESTINATIONS: "true" }).host).toBe("127.0.0.1");
		expect(load({ ALLOW_PRIVATE_DESTINATIONS: "true", HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
	});
});

describe("normalizeBasePath", () => {
	it.each([
		["/", "/"],
		["", "/"],
		["deblocker", "/deblocker/"],
		["/deblocker", "/deblocker/"],
		["/a/b/", "/a/b/"],
		["//a//b", "/a/b/"],
	])("%j -> %j", (input, expected) => {
		expect(normalizeBasePath(input)).toBe(expected);
	});

	it("rejects traversal and odd characters", () => {
		const problems: string[] = [];
		expect(normalizeBasePath("/a/../b", problems)).toBe("/");
		expect(normalizeBasePath("/a b", problems)).toBe("/");
		expect(problems).toHaveLength(2);
	});
});

describe("toPublicConfig", () => {
	it("never exposes secrets", () => {
		const config = load({ ACCESS_KEY: "supersecret", SESSION_SECRET: "s".repeat(40), DESTINATION_ALLOWLIST: "example.com" });
		const exposed = JSON.stringify(toPublicConfig(config, "1.0.0", { scramjet: "a", controller: "b", transport: "c" }));
		expect(exposed).not.toContain("supersecret");
		expect(exposed).not.toContain("s".repeat(40));
		expect(exposed).not.toContain("example.com");
		expect(JSON.parse(exposed).accessKeyRequired).toBe(true);
	});
});
