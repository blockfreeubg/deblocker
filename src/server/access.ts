import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "deblocker_session";

export interface AccessControlOptions {
	key: string | null;
	sessionSecret: string | null;
	sessionTtlSeconds: number;
	cookiePath: string;
}

/**
 * Optional access key. When ACCESS_KEY is set, visitors must enter it once; they then get a
 * signed, HttpOnly session cookie that the Wisp WebSocket endpoint checks on every upgrade.
 */
export class AccessControl {
	readonly required: boolean;
	private readonly keyDigest: Buffer | null;
	private readonly secret: Buffer;

	constructor(private readonly options: AccessControlOptions) {
		this.required = options.key !== null;
		this.keyDigest = options.key === null ? null : sha256(options.key);
		const base = options.sessionSecret ? Buffer.from(options.sessionSecret, "utf8") : randomBytes(32);
		// Bind sessions to the key itself, so changing ACCESS_KEY signs everyone out.
		this.secret = this.keyDigest ? createHmac("sha256", base).update("deblocker-session-v1\0").update(this.keyDigest).digest() : base;
	}

	verifyKey(candidate: unknown): boolean {
		if (!this.keyDigest || typeof candidate !== "string" || candidate.length === 0 || candidate.length > 1024) return false;
		return timingSafeEqual(sha256(candidate), this.keyDigest);
	}

	isAuthenticated(cookieHeader: string | undefined, now = Date.now()): boolean {
		if (!this.required) return true;
		const token = readCookie(cookieHeader, SESSION_COOKIE);
		if (!token) return false;
		const match = /^v1\.(\d{10,13})\.([A-Za-z0-9_-]{43})$/.exec(token);
		if (!match) return false;
		const expires = Number(match[1]);
		if (!Number.isFinite(expires) || expires * 1000 <= now) return false;
		const expected = Buffer.from(this.sign(`v1.${expires}`), "utf8");
		const actual = Buffer.from(match[2]!, "utf8");
		return expected.length === actual.length && timingSafeEqual(expected, actual);
	}

	sessionCookie(secure: boolean, now = Date.now()): string {
		const expires = Math.floor(now / 1000) + this.options.sessionTtlSeconds;
		const value = `v1.${expires}.${this.sign(`v1.${expires}`)}`;
		return serializeCookie(value, this.options.sessionTtlSeconds, this.options.cookiePath, secure);
	}

	clearedCookie(secure: boolean): string {
		return serializeCookie("", 0, this.options.cookiePath, secure);
	}

	private sign(payload: string): string {
		return createHmac("sha256", this.secret).update(payload).digest("base64url");
	}
}

function sha256(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

function serializeCookie(value: string, maxAge: number, path: string, secure: boolean): string {
	const parts = [`${SESSION_COOKIE}=${value}`, `Path=${path}`, `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Strict"];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

export function readCookie(header: string | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index === -1) continue;
		if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
	}
	return null;
}

/** Fixed-window attempt counter, used to slow down access-key guessing. Memory use is bounded. */
export class AttemptLimiter {
	private readonly windows = new Map<string, { count: number; resetAt: number }>();
	private lastSweep = 0;

	constructor(
		private readonly maxAttempts: number,
		private readonly windowMs: number,
		private readonly maxKeys = 10_000,
	) {}

	/** Records an attempt and returns false when the caller is over the limit. */
	attempt(key: string, now = Date.now()): boolean {
		if (this.windows.size >= this.maxKeys) this.makeRoom(now);
		const entry = this.windows.get(key);
		if (!entry || entry.resetAt <= now) {
			this.windows.delete(key);
			this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
			return true;
		}
		entry.count += 1;
		return entry.count <= this.maxAttempts;
	}

	retryAfterSeconds(key: string, now = Date.now()): number {
		const entry = this.windows.get(key);
		return entry ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
	}

	get size(): number {
		return this.windows.size;
	}

	private makeRoom(now: number) {
		if (now - this.lastSweep > 60_000) {
			this.lastSweep = now;
			for (const [key, entry] of this.windows) if (entry.resetAt <= now) this.windows.delete(key);
		}
		// Still full: forget the oldest windows (Map iteration follows insertion order).
		for (const key of this.windows.keys()) {
			if (this.windows.size < this.maxKeys) break;
			this.windows.delete(key);
		}
	}
}
