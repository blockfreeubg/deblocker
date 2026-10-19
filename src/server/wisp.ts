import { Resolver as DnsResolver, lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { logging as wispLogging, server as wispServer } from "@mercuryworkshop/wisp-js/server";
import { WebSocketServer, type WebSocket } from "ws";
import type { AccessControl } from "./access.js";
import type { ServerConfig } from "./config.js";
import { clientIp, compileTrust, isAllowedOrigin, isRebindingSafeHost, rejectUpgrade } from "./http-utils.js";
import type { Logger } from "./logger.js";
import { isValidHostname, type DestinationPolicy } from "./policy.js";
import { clientKey } from "../shared/net.js";

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/** Largest WebSocket frame accepted from a client (Wisp transports send far smaller packets). */
const MAX_FRAME_BYTES = 1 << 20;
/** Data a client may have queued towards destinations that read slowly, per stream / connection / server. */
const STREAM_BUFFER_BYTES = 16 << 20;
const CONNECTION_BUFFER_BYTES = 64 << 20;
const SERVER_BUFFER_BYTES = 256 << 20;

const PACKET_CONNECT = 0x01;
const PACKET_DATA = 0x02;
const CLOSE_THROTTLED = 0x49;

/**
 * Production resolver: c-ares (dns.Resolver) runs off the libuv thread pool, so slow or hostile name
 * servers can't starve the rest of the server, and it never consults /etc/hosts. In development
 * (private destinations allowed) the system resolver is used so names like "localhost" work.
 */
export function createResolver(allowPrivate: boolean): Resolver {
	if (allowPrivate) return (hostname) => lookup(hostname, { all: true, order: "ipv4first" });
	const resolver = new DnsResolver({ timeout: 4000, tries: 2 });
	return async (hostname) => {
		let firstError: unknown;
		try {
			const v4 = await resolver.resolve4(hostname);
			if (v4.length > 0) return v4.map((address) => ({ address, family: 4 }));
		} catch (error) {
			firstError = error;
		}
		try {
			const v6 = await resolver.resolve6(hostname);
			if (v6.length > 0) return v6.map((address) => ({ address, family: 6 }));
		} catch (error) {
			firstError ??= error;
		}
		throw firstError ?? new Error(`${hostname} has no addresses`);
	};
}

/**
 * Applies Deblocker's destination policy to the (process-global) wisp-js server options.
 *
 * - Hostnames, including IP literals, go through DestinationPolicy before anything else.
 *   wisp-js only needs an object with a `test()` method in its blacklist, so the policy plugs in directly.
 * - DNS resolution goes through our resolver, which refuses non-public addresses and returns the exact
 *   address the socket will connect to. That closes the DNS-rebinding gap between "check" and "connect".
 * - UDP streams are disabled; only TCP to the allowed ports is permitted.
 */
export function configureWisp(config: ServerConfig, policy: DestinationPolicy, logger: Logger, resolver?: Resolver): void {
	const resolve = resolver ?? createResolver(config.destinations.allowPrivate);
	const options = wispServer.options;
	options.hostname_whitelist = null;
	options.hostname_blacklist = [
		{
			test(hostname: string) {
				const decision = policy.checkHost(hostname);
				if (!decision.allowed) logger.debug(`wisp: refused ${JSON.stringify(hostname)}: ${decision.reason}`);
				return !decision.allowed;
			},
		},
	];
	options.port_blacklist = null;
	options.port_whitelist = config.destinations.ports === "any" ? null : [...config.destinations.ports];
	options.allow_direct_ip = true;
	options.allow_private_ips = config.destinations.allowPrivate;
	options.allow_loopback_ips = config.destinations.allowPrivate;
	options.allow_tcp_streams = true;
	options.allow_udp_streams = false;
	// wisp-js counts the new stream before comparing, hence +1. Live sockets are also capped per connection below.
	options.stream_limit_total = config.limits.maxStreamsPerConnection + 1;
	// wisp-js 0.5.0 iterates an object for the per-host limit and would throw, so leave it off.
	options.stream_limit_per_host = -1;
	options.dns_ttl = 30_000;
	options.dns_method = async (hostname: string) => {
		if (!isValidHostname(hostname)) throw new Error("invalid hostname");
		const records = await resolve(hostname);
		const usable = records.find((record) => policy.checkResolvedAddress(record.address).allowed);
		if (!usable) {
			logger.debug(`wisp: refused ${hostname}: resolves only to non-public addresses`);
			throw new Error(`${hostname} resolves to a non-public address`);
		}
		return usable.address;
	};
	options.parse_real_ip = false;
	options.wisp_version = 2;
	options.wisp_motd = null;

	// wisp-js logs destinations at info and warn level (connections, refusals, failures). Keep visitors'
	// browsing out of the logs entirely unless the operator asked for debug output.
	wispLogging.set_level(config.logLevel === "debug" ? wispLogging.DEBUG : wispLogging.NONE);
}

export interface WispGatewayOptions {
	config: ServerConfig;
	access: AccessControl;
	logger: Logger;
}

interface TcpSocketLike {
	socket?: Duplex;
	connect(): Promise<void>;
	send(data: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

interface WispConnection {
	TCPSocket: new (hostname: string, port: number) => TcpSocketLike;
	streams: Record<number, { socket: TcpSocketLike } | undefined>;
	route_packet(buffer: { bytes: Uint8Array; size: number }): void;
	close_stream(id: number, reason?: number | null): Promise<void>;
	setup(): Promise<void>;
	run(): Promise<void>;
}

/** Handles HTTP upgrades for the Wisp endpoint, enforcing origin, access-key and per-IP limits. */
export class WispGateway {
	readonly path: string;
	private readonly trust;
	private readonly perClient = new Map<string, number>();
	private readonly sockets = new Set<Duplex>();
	private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
	/** Bytes queued towards destinations across all connections. */
	private bufferedTotal = 0;
	private closing = false;

	constructor(private readonly options: WispGatewayOptions) {
		this.path = `${options.config.basePath}wisp/`;
		this.trust = compileTrust(options.config.trustProxy);
	}

	get connectionCount(): number {
		return this.sockets.size;
	}

	/** Returns false when the request is not for the Wisp endpoint, so other upgrade handlers can take it. */
	handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		// Compare the raw path: URL parsing can throw on request targets Node's HTTP parser accepts.
		const pathname = (request.url ?? "/").split("?", 1)[0];
		if (pathname !== this.path) return false;
		socket.on("error", () => socket.destroy());

		const { config, access, logger } = this.options;
		const ip = clientIp(request, this.trust);
		const client = clientKey(ip);

		if (this.closing) {
			rejectUpgrade(socket, 503, "Server is shutting down");
			return true;
		}
		if ((request.headers.upgrade ?? "").toLowerCase() !== "websocket") {
			rejectUpgrade(socket, 400, "Expected a WebSocket upgrade");
			return true;
		}
		if (!isAllowedOrigin(request, config.allowedOrigins, config.trustProxy !== false)) {
			logger.warn(`wisp: rejected connection from ${ip} with origin ${request.headers.origin ?? "(none)"}`);
			rejectUpgrade(socket, 403, "Origin not allowed");
			return true;
		}
		if (config.destinations.allowPrivate && !isRebindingSafeHost(request, config.allowedOrigins)) {
			logger.warn(`wisp: rejected connection from ${ip} for host ${request.headers.host ?? "(none)"} (private destinations are on; add it to ALLOWED_ORIGINS)`);
			rejectUpgrade(socket, 403, "Host not allowed");
			return true;
		}
		if (!access.isAuthenticated(request.headers.cookie)) {
			rejectUpgrade(socket, 401, "Access key required");
			return true;
		}
		const current = this.perClient.get(client) ?? 0;
		if (current >= config.limits.maxConnectionsPerIp) {
			logger.warn(`wisp: too many connections from ${client}`);
			rejectUpgrade(socket, 429, "Too many connections");
			return true;
		}

		this.perClient.set(client, current + 1);
		this.sockets.add(socket);
		socket.once("close", () => {
			this.sockets.delete(socket);
			const remaining = (this.perClient.get(client) ?? 1) - 1;
			if (remaining <= 0) this.perClient.delete(client);
			else this.perClient.set(client, remaining);
		});
		logger.debug(`wisp: connection from ${ip}`);
		const version = request.headers["sec-websocket-protocol"] ? 2 : 1;
		this.wss.handleUpgrade(request, socket, head, (ws) => this.serve(ws, version));
		return true;
	}

	/**
	 * Runs one Wisp connection with wisp-js, adding the limits it lacks: a WebSocket error handler
	 * (an unhandled one would crash the process), a cap on live destination sockets, rejection of reused
	 * stream ids, and budgets for data queued towards destinations that read slowly.
	 */
	private serve(ws: WebSocket, version: 1 | 2) {
		const { limits } = this.options.config;
		const gateway = this;
		ws.on("error", () => ws.terminate());

		const conn = new wispServer.ServerConnection(ws, this.path, { wisp_version: version }) as unknown as WispConnection;
		const live = new Set<TrackedSocket>();
		let bufferedConnection = 0;

		class TrackedSocket extends conn.TCPSocket {
			queued = 0;

			override async connect() {
				if (live.size >= limits.maxStreamsPerConnection) throw new Error("too many open streams");
				live.add(this);
				try {
					await super.connect();
				} catch (error) {
					this.forget();
					throw error;
				}
				this.socket?.once("close", () => this.forget());
			}

			override async send(data: Uint8Array) {
				try {
					await super.send(data);
				} finally {
					this.release(data.byteLength);
				}
			}

			override async close() {
				this.forget();
				return super.close();
			}

			account(bytes: number) {
				this.queued += bytes;
				bufferedConnection += bytes;
				gateway.bufferedTotal += bytes;
			}

			release(bytes: number) {
				const amount = Math.min(bytes, this.queued);
				this.queued -= amount;
				bufferedConnection -= amount;
				gateway.bufferedTotal -= amount;
			}

			forget() {
				live.delete(this);
				this.release(this.queued);
			}
		}
		conn.TCPSocket = TrackedSocket;

		const route = conn.route_packet.bind(conn);
		conn.route_packet = (buffer) => {
			if (buffer.size >= 5) {
				const type = buffer.bytes[0];
				const id = new DataView(buffer.bytes.buffer, buffer.bytes.byteOffset, buffer.bytes.byteLength).getUint32(1, true);
				// Reusing a live stream id would orphan the old socket and dodge the stream limit.
				if (type === PACKET_CONNECT && conn.streams[id]) return;
				if (type === PACKET_DATA) {
					const socket = conn.streams[id]?.socket;
					if (socket instanceof TrackedSocket) {
						const bytes = buffer.size - 5;
						if (
							socket.queued + bytes > STREAM_BUFFER_BYTES ||
							bufferedConnection + bytes > CONNECTION_BUFFER_BYTES ||
							gateway.bufferedTotal + bytes > SERVER_BUFFER_BYTES
						) {
							void conn.close_stream(id, CLOSE_THROTTLED);
							return;
						}
						socket.account(bytes);
					}
				}
			}
			route(buffer);
		};

		ws.once("close", () => {
			for (const socket of live) socket.socket?.destroy();
			live.clear();
		});
		conn
			.setup()
			.then(() => conn.run())
			.catch(() => ws.terminate());
	}

	/** Stops accepting connections and closes the open ones (used on shutdown). */
	closeAll(): void {
		this.closing = true;
		for (const client of this.wss.clients) client.terminate();
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		this.perClient.clear();
	}
}
