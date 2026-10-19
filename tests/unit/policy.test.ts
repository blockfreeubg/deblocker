import { describe, expect, it } from "vitest";
import { DestinationPolicy, hostMatches, hostPatternRegex } from "../../src/server/policy.js";

const base = { ports: [80, 443] as number[] | "any", allowPrivate: false, allowlist: [] as string[], blocklist: [] as string[] };

describe("hostMatches / hostPatternRegex", () => {
	it.each([
		["example.com", "example.com", true],
		["www.example.com", "example.com", true],
		["a.b.example.com.", "example.com", true],
		["EXAMPLE.COM", "example.com", true],
		["badexample.com", "example.com", false],
		["example.com.evil.net", "example.com", false],
	])("%s vs %s -> %s", (host, entry, expected) => {
		expect(hostMatches(host, entry)).toBe(expected);
		expect(hostPatternRegex(entry).test(host)).toBe(expected);
	});
});

describe("DestinationPolicy", () => {
	it("allows public hosts on allowed ports only", () => {
		const policy = new DestinationPolicy(base);
		expect(policy.check("example.com", 443)).toEqual({ allowed: true });
		expect(policy.check("example.com", 80)).toEqual({ allowed: true });
		expect(policy.check("example.com", 22).allowed).toBe(false);
		expect(new DestinationPolicy({ ...base, ports: "any" }).check("example.com", 22).allowed).toBe(true);
	});

	it.each(["localhost", "127.0.0.1", "10.0.0.1", "192.168.1.20", "169.254.169.254", "[::1]", "::ffff:127.0.0.1", "router.local", "metadata.google.internal"])(
		"refuses private destination %s",
		(host) => {
			expect(new DestinationPolicy(base).check(host, 80).allowed).toBe(false);
		},
	);

	it("permits private destinations only when explicitly enabled", () => {
		const policy = new DestinationPolicy({ ...base, allowPrivate: true });
		expect(policy.check("127.0.0.1", 80).allowed).toBe(true);
		expect(policy.checkResolvedAddress("10.0.0.1").allowed).toBe(true);
	});

	it("refuses public names that resolve to private addresses", () => {
		const policy = new DestinationPolicy(base);
		expect(policy.checkResolvedAddress("93.184.215.14").allowed).toBe(true);
		expect(policy.checkResolvedAddress("127.0.0.1").allowed).toBe(false);
		expect(policy.checkResolvedAddress("fd00::1").allowed).toBe(false);
	});

	it("applies the blocklist to subdomains", () => {
		const policy = new DestinationPolicy({ ...base, blocklist: ["blocked.example"] });
		expect(policy.check("blocked.example", 443).allowed).toBe(false);
		expect(policy.check("cdn.blocked.example", 443).allowed).toBe(false);
		expect(policy.check("notblocked.example", 443).allowed).toBe(true);
	});

	it("restricts to the allowlist when one is configured", () => {
		const policy = new DestinationPolicy({ ...base, allowlist: ["wikipedia.org", "wikimedia.org"] });
		expect(policy.check("en.wikipedia.org", 443).allowed).toBe(true);
		expect(policy.check("upload.wikimedia.org", 443).allowed).toBe(true);
		expect(policy.check("example.com", 443).allowed).toBe(false);
		expect(policy.check("1.1.1.1", 443).allowed).toBe(false);
	});

	it("lets the blocklist win over the allowlist", () => {
		const policy = new DestinationPolicy({ ...base, allowlist: ["example.com"], blocklist: ["private.example.com"] });
		expect(policy.check("www.example.com", 443).allowed).toBe(true);
		expect(policy.check("private.example.com", 443).allowed).toBe(false);
	});
});
