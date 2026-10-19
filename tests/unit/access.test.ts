import { describe, expect, it } from "vitest";
import { AccessControl, AttemptLimiter, SESSION_COOKIE, readCookie } from "../../src/server/access.js";

const options = { key: "correct horse battery", sessionSecret: "x".repeat(32), sessionTtlSeconds: 3600, cookiePath: "/deblocker/" };

function cookieValue(setCookie: string): string {
	return setCookie.split(";")[0]!;
}

describe("AccessControl", () => {
	it("is open when no key is configured", () => {
		const access = new AccessControl({ ...options, key: null });
		expect(access.required).toBe(false);
		expect(access.isAuthenticated(undefined)).toBe(true);
		expect(access.verifyKey("anything")).toBe(false);
	});

	it("verifies the key in constant time and rejects junk", () => {
		const access = new AccessControl(options);
		expect(access.verifyKey("correct horse battery")).toBe(true);
		expect(access.verifyKey("correct horse batter")).toBe(false);
		expect(access.verifyKey("")).toBe(false);
		expect(access.verifyKey(42)).toBe(false);
		expect(access.verifyKey(undefined)).toBe(false);
	});

	it("issues session cookies that authenticate until they expire", () => {
		const access = new AccessControl(options);
		const now = Date.UTC(2026, 0, 1);
		const header = access.sessionCookie(true, now);
		expect(header).toContain("HttpOnly");
		expect(header).toContain("SameSite=Strict");
		expect(header).toContain("Path=/deblocker/");
		expect(header).toContain("Secure");
		const cookie = `other=1; ${cookieValue(header)}`;
		expect(access.isAuthenticated(cookie, now + 1000)).toBe(true);
		expect(access.isAuthenticated(cookie, now + 3601 * 1000)).toBe(false);
	});

	it("rejects forged, tampered and foreign cookies", () => {
		const access = new AccessControl(options);
		const other = new AccessControl({ ...options, sessionSecret: "y".repeat(32) });
		const now = Date.now();
		const value = readCookie(cookieValue(access.sessionCookie(false, now)), SESSION_COOKIE)!;
		const [version, expires, signature] = value.split(".");
		expect(access.isAuthenticated(`${SESSION_COOKIE}=${version}.${Number(expires) + 100000}.${signature}`)).toBe(false);
		expect(access.isAuthenticated(`${SESSION_COOKIE}=garbage`)).toBe(false);
		expect(other.isAuthenticated(`${SESSION_COOKIE}=${value}`)).toBe(false);
		expect(access.isAuthenticated(undefined)).toBe(false);
	});

	it("signs everyone out when the access key changes", () => {
		const before = new AccessControl(options);
		const cookie = cookieValue(before.sessionCookie(false));
		const rotated = new AccessControl({ ...options, key: "a brand new key" });
		expect(before.isAuthenticated(cookie)).toBe(true);
		expect(rotated.isAuthenticated(cookie)).toBe(false);
	});

	it("omits Secure on plain http", () => {
		const access = new AccessControl(options);
		expect(access.sessionCookie(false)).not.toContain("Secure");
		expect(access.clearedCookie(false)).toContain("Max-Age=0");
	});
});

describe("AttemptLimiter", () => {
	it("blocks after the limit and resets after the window", () => {
		const limiter = new AttemptLimiter(3, 60_000);
		const now = 1_000_000;
		expect([1, 2, 3].map(() => limiter.attempt("ip", now))).toEqual([true, true, true]);
		expect(limiter.attempt("ip", now)).toBe(false);
		expect(limiter.attempt("other", now)).toBe(true);
		expect(limiter.retryAfterSeconds("ip", now)).toBe(60);
		expect(limiter.attempt("ip", now + 60_001)).toBe(true);
	});

	it("keeps memory bounded under address rotation", () => {
		const limiter = new AttemptLimiter(3, 60_000, 100);
		for (let i = 0; i < 1000; i++) limiter.attempt(`client-${i}`, 1_000_000);
		expect(limiter.size).toBeLessThanOrEqual(100);
	});
});
