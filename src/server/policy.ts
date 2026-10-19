import type { DestinationConfig } from "./config.js";
import { isIPv4Literal, isIPv6Literal, isLocalHostname, isNonPublicAddress } from "../shared/net.js";

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** "example.com" matches example.com itself and every subdomain of it. */
export function hostMatches(hostname: string, entry: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return host === entry || host.endsWith(`.${entry}`);
}

/** Regular expression equivalent of hostMatches, for libraries that take regex lists. */
export function hostPatternRegex(entry: string): RegExp {
	const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^(?:.+\\.)?${escaped}\\.?$`, "i");
}

/**
 * Server-side rules for where proxied connections may go. Checked for every Wisp stream
 * before a socket is opened, and again for the resolved IP address.
 */
export class DestinationPolicy {
	constructor(private readonly config: DestinationConfig) {}

	get allowPrivate(): boolean {
		return this.config.allowPrivate;
	}

	checkPort(port: number): PolicyDecision {
		if (this.config.ports === "any" || this.config.ports.includes(port)) return { allowed: true };
		return { allowed: false, reason: `port ${port} is not allowed` };
	}

	/** Checks the hostname exactly as the client requested it (before DNS resolution). */
	checkHost(hostname: string): PolicyDecision {
		const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
		if (!host) return { allowed: false, reason: "empty hostname" };

		if (!this.config.allowPrivate && (isLocalHostname(host) || isNonPublicAddress(host))) {
			return { allowed: false, reason: "private or local destination" };
		}
		if (this.config.blocklist.some((entry) => hostMatches(host, entry))) {
			return { allowed: false, reason: "destination is on the blocklist" };
		}
		if (this.config.allowlist.length > 0) {
			const isIp = isIPv4Literal(host) || isIPv6Literal(host);
			if (isIp || !this.config.allowlist.some((entry) => hostMatches(host, entry))) {
				return { allowed: false, reason: "destination is not on the allowlist" };
			}
		}
		return { allowed: true };
	}

	/** Checks an address after DNS resolution, so public names that point at private IPs are refused too. */
	checkResolvedAddress(address: string): PolicyDecision {
		if (!this.config.allowPrivate && isNonPublicAddress(address)) {
			return { allowed: false, reason: "destination resolves to a private address" };
		}
		return { allowed: true };
	}

	check(hostname: string, port: number): PolicyDecision {
		const portDecision = this.checkPort(port);
		return portDecision.allowed ? this.checkHost(hostname) : portDecision;
	}
}
