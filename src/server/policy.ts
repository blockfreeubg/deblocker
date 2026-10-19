import type { DestinationConfig } from "./config.js";
import { isIPv4Literal, isIPv6Literal, isLocalHostname, isNonPublicAddress } from "../shared/net.js";

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

const DNS_NAME = /^(?=.{1,253}$)[a-z0-9_-]{1,63}(?:\.[a-z0-9_-]{1,63})*$/;

/**
 * True for IP literals and well-formed DNS names. Anything else (NUL bytes, control characters,
 * spaces, empty labels) is refused: the resolver would truncate or reinterpret it, so the name that
 * was checked would not be the name that gets connected to.
 */
export function isValidHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	// Only characters a DNS name or IP literal can contain (no zone ids, NUL bytes or whitespace).
	if (!host || /[^a-z0-9._:-]/.test(host)) return false;
	return isIPv4Literal(host) || isIPv6Literal(host) || DNS_NAME.test(host);
}

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
		if (!isValidHostname(host)) return { allowed: false, reason: "invalid hostname" };
		const isIp = isIPv4Literal(host) || isIPv6Literal(host);

		if (!this.config.allowPrivate && (isLocalHostname(host) || isNonPublicAddress(host))) {
			return { allowed: false, reason: "private or local destination" };
		}
		if (this.config.blocklist.some((entry) => hostMatches(host, entry))) {
			return { allowed: false, reason: "destination is on the blocklist" };
		}
		if (this.config.allowlist.length > 0) {
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
