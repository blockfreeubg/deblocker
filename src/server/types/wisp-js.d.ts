// Minimal typings for the parts of @mercuryworkshop/wisp-js (which ships no types) that Deblocker uses.
declare module "@mercuryworkshop/wisp-js/server" {
	import type { IncomingMessage } from "node:http";
	import type { Duplex } from "node:stream";

	export interface HostnameMatcher {
		test(hostname: string): boolean;
	}

	export interface WispServerOptions {
		hostname_blacklist: HostnameMatcher[] | null;
		hostname_whitelist: HostnameMatcher[] | null;
		port_blacklist: Array<number | [number, number]> | null;
		port_whitelist: Array<number | [number, number]> | null;
		allow_direct_ip: boolean;
		allow_private_ips: boolean;
		allow_loopback_ips: boolean;
		stream_limit_per_host: number;
		stream_limit_total: number;
		allow_udp_streams: boolean;
		allow_tcp_streams: boolean;
		dns_ttl: number;
		dns_method: "lookup" | "resolve" | ((hostname: string) => Promise<string>);
		dns_servers: string[] | null;
		dns_result_order: "verbatim" | "ipv4first" | "ipv6first";
		parse_real_ip: boolean;
		parse_real_ip_from: string[];
		wisp_version: 1 | 2;
		wisp_motd: string | null;
	}

	export const server: {
		options: WispServerOptions;
		routeRequest(request: IncomingMessage, socket: Duplex, head: Buffer, connectionOptions?: Record<string, unknown>): void;
	};

	export const logging: {
		DEBUG: number;
		INFO: number;
		WARN: number;
		ERROR: number;
		NONE: number;
		set_level(level: number): void;
	};
}
