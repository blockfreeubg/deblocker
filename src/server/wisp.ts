import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { logging as wispLogging, server as wispServer } from "@mercuryworkshop/wisp-js/server";
import type { AccessControl } from "./access.js";
import type { ServerConfig } from "./config.js";
import { clientIp, compileTrust, isAllowedOrigin, rejectUpgrade } from "./http-utils.js";
import type { Logger } from "./logger.js";
import type { DestinationPolicy } from "./policy.js";

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true, order: "ipv4first" });

/**
 * Applies Deblocker's destination policy to the (process-global) wisp-js server options.
 *
 * - Hostnames, including IP literals, go through DestinationPolicy before anything else.
 *   wisp-js only needs an object with a `test()` method in its blacklist, so the policy plugs in directly.
 * - DNS resolution goes through our resolver, which refuses non-public addresses and returns the exact
 *   address the socket will connect to. That closes the DNS-rebinding gap between "check" and "connect".
 * - UDP streams are disabled; only TCP to the allowed ports is permitted.
 */
export function configureWisp(config: ServerConfig, policy: DestinationPolicy, logger: Logger, resolver: Resolver = systemResolver): void {
	const options = wispServer.options;
	options.hostname_whitelist = null;
	options.hostname_blacklist = [
		{
			test(hostname: string) {
				const decision = policy.checkHost(hostname);
				if (!decision.allowed) logger.debug(`wisp: refused ${hostname}: ${decision.reason}`);
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
	options.stream_limit_total = config.limits.maxStreamsPerConnection;
	// wisp-js 0.5.0 iterates an object for the per-host limit and would throw, so leave it off.
	options.stream_limit_per_host = -1;
	options.dns_ttl = 30_000;
	options.dns_method = async (hostname: string) => {
		const records = await resolver(hostname);
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

	// wisp-js logs every destination at "info"; keep visitors' browsing out of the logs unless debugging.
	wispLogging.set_level(config.logLevel === "debug" ? wispLogging.DEBUG : wispLogging.WARN);
}

export interface WispGatewayOptions {
	config: ServerConfig;
	access: AccessControl;
	logger: Logger;
}

/** Handles HTTP upgrades for the Wisp endpoint, enforcing origin, access-key and per-IP limits. */
export class WispGateway {
	readonly path: string;
	private readonly trust;
	private readonly perIp = new Map<string, number>();
	private readonly sockets = new Set<Duplex>();
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
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname !== this.path) return false;

		const { config, access, logger } = this.options;
		const ip = clientIp(request, this.trust);

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
		if (!access.isAuthenticated(request.headers.cookie)) {
			rejectUpgrade(socket, 401, "Access key required");
			return true;
		}
		const current = this.perIp.get(ip) ?? 0;
		if (current >= config.limits.maxConnectionsPerIp) {
			logger.warn(`wisp: too many connections from ${ip}`);
			rejectUpgrade(socket, 429, "Too many connections");
			return true;
		}

		this.perIp.set(ip, current + 1);
		this.sockets.add(socket);
		socket.once("close", () => {
			this.sockets.delete(socket);
			const remaining = (this.perIp.get(ip) ?? 1) - 1;
			if (remaining <= 0) this.perIp.delete(ip);
			else this.perIp.set(ip, remaining);
		});
		logger.debug(`wisp: connection from ${ip}`);
		wispServer.routeRequest(request, socket, head);
		return true;
	}

	/** Stops accepting connections and closes the open ones (used on shutdown). */
	closeAll(): void {
		this.closing = true;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		this.perIp.clear();
	}
}
