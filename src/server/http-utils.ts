import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import proxyaddr from "proxy-addr";

export type TrustFunction = (address: string, hop: number) => boolean;

/** Same semantics as Express' "trust proxy" setting, usable for raw upgrade requests. */
export function compileTrust(value: boolean | number | string[]): TrustFunction {
	if (value === true) return () => true;
	if (value === false) return () => false;
	if (typeof value === "number") return (_address, hop) => hop < value;
	return proxyaddr.compile(value);
}

export function clientIp(request: IncomingMessage, trust: TrustFunction): string {
	try {
		return proxyaddr(request, trust);
	} catch {
		return request.socket.remoteAddress ?? "unknown";
	}
}

const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	429: "Too Many Requests",
	503: "Service Unavailable",
};

/** Refuses a WebSocket upgrade with a plain HTTP response and closes the socket. */
export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
	if (socket.writable) {
		const body = `${message}\n`;
		socket.write(
			`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\n` +
				"Connection: close\r\n" +
				"Content-Type: text/plain; charset=utf-8\r\n" +
				`Content-Length: ${Buffer.byteLength(body)}\r\n` +
				"\r\n" +
				body,
		);
	}
	socket.destroy();
}

/**
 * Accepts the request only if its Origin matches the host it was sent to (or an explicitly allowed origin).
 * This stops other websites from using a visitor's browser to tunnel traffic through this server.
 */
export function isAllowedOrigin(request: IncomingMessage, allowedOrigins: string[], trustForwardedHost: boolean): boolean {
	const origin = request.headers.origin;
	if (!origin) return false;
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	if (allowedOrigins.includes(parsed.origin)) return true;
	const hosts = new Set<string>();
	if (request.headers.host) hosts.add(request.headers.host.toLowerCase());
	const forwarded = request.headers["x-forwarded-host"];
	if (trustForwardedHost && typeof forwarded === "string") {
		const first = forwarded.split(",")[0]?.trim().toLowerCase();
		if (first) hosts.add(first);
	}
	return hosts.has(parsed.host.toLowerCase());
}
