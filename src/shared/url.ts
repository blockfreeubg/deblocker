import { isIPv4Literal, isLocalHostname, isNonPublicAddress } from "./net.js";

export type InternalPage = "home" | "settings" | "about";

export const INTERNAL_SCHEME = "deblocker:";

export type InputResult =
	| { kind: "url"; url: string }
	| { kind: "search"; url: string; query: string }
	| { kind: "internal"; page: InternalPage }
	| { kind: "error"; message: string };

const INTERNAL_PAGES: Record<string, InternalPage> = {
	home: "home",
	newtab: "home",
	settings: "settings",
	about: "about",
	credits: "about",
};

/** Schemes that can never be proxied. Anything else with a colon may still be a search ("c++: tutorial"). */
const BLOCKED_SCHEMES = new Set([
	"javascript",
	"vbscript",
	"data",
	"blob",
	"file",
	"filesystem",
	"about",
	"chrome",
	"chrome-extension",
	"edge",
	"brave",
	"moz-extension",
	"view-source",
	"ftp",
	"ws",
	"wss",
	"mailto",
	"tel",
	"sms",
	"intent",
]);

const HOST_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Very small heuristic deciding whether a bare hostname is meant as an address. */
function isPlausibleHostname(hostname: string): boolean {
	const host = hostname.replace(/\.$/, "");
	if (host === "localhost") return true;
	if (isIPv4Literal(host)) return true;
	if (host.startsWith("[") && host.endsWith("]")) return true;
	const labels = host.split(".");
	if (labels.length < 2) return false;
	if (!labels.every((label) => HOST_LABEL.test(label))) return false;
	return TLD.test(labels[labels.length - 1]!);
}

export function buildSearchUrl(query: string, template: string): string {
	return template.replace("%s", encodeURIComponent(query));
}

function parseWebUrl(candidate: string): URL | null {
	try {
		const url = new URL(candidate);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (!url.hostname) return null;
		return url;
	} catch {
		return null;
	}
}

function finishUrl(url: URL): InputResult {
	if (url.username || url.password) {
		return { kind: "error", message: "Addresses that contain a username or password aren't supported." };
	}
	return { kind: "url", url: url.href };
}

/**
 * Turns whatever the visitor typed into something Deblocker can open:
 * a full http(s) URL, a search, or one of the built-in pages.
 */
export function resolveInput(raw: string, searchTemplate: string): InputResult {
	const input = raw.trim();
	if (!input) return { kind: "error", message: "Type a web address or something to search for." };
	if (input.length > 8192) return { kind: "error", message: "That address is too long." };

	const internal = /^deblocker:\/\/([a-z-]*)\/?$/i.exec(input);
	if (internal) {
		const page = INTERNAL_PAGES[internal[1]!.toLowerCase() || "home"];
		return page ? { kind: "internal", page } : { kind: "error", message: `There is no built-in page called "${input}".` };
	}

	const search = (): InputResult => ({ kind: "search", query: input, url: buildSearchUrl(input, searchTemplate) });

	// "example.com:8080/path" and "localhost:3000" look like a scheme to the URL parser, so check for host:port first.
	const hostWithPort = /^([^\s/?#:@]+):(\d{1,5})(?:[/?#]|$)/.exec(input);
	if (!hostWithPort || !isPlausibleHostname(hostWithPort[1]!.toLowerCase())) {
		const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(input);
		if (scheme) {
			const name = scheme[1]!.toLowerCase();
			if (name === "http" || name === "https") {
				const url = parseWebUrl(input);
				if (!url || !isPlausibleHostname(url.hostname) || /\s/.test(url.host)) {
					return { kind: "error", message: "That doesn't look like a valid web address." };
				}
				return finishUrl(url);
			}
			if (BLOCKED_SCHEMES.has(name)) {
				return { kind: "error", message: `Deblocker only opens http and https pages, not "${name}:" links.` };
			}
			// Something like "note: groceries" or "c++: tutorial" is a search.
			return search();
		}
	}

	const withoutSlashes = input.startsWith("//") ? input.slice(2) : input;
	// Everything before the first "/", "?" or "#" must be a hostname (optionally with a port) without spaces.
	const hostPart = withoutSlashes.split(/[/?#]/, 1)[0] ?? "";
	if (!hostPart || /\s/.test(hostPart) || hostPart.includes("@")) return search();

	const hostOnly = hostPart.replace(/:\d{1,5}$/, "").toLowerCase();
	// "1.5" or "3.14" are numbers, not IPv4 shorthand.
	if (/^[\d.]+$/.test(hostOnly) && !isIPv4Literal(hostOnly)) return search();

	const url = parseWebUrl(`https://${withoutSlashes}`);
	if (!url || !isPlausibleHostname(url.hostname)) return search();
	return finishUrl(url);
}

export interface DestinationHints {
	ports: number[] | "any";
	privateDestinations: boolean;
}

/**
 * Early, friendly explanation for destinations the server will refuse anyway.
 * The server-side policy is authoritative; this only avoids a confusing failed load.
 */
export function explainBlockedDestination(href: string, hints: DestinationHints): string | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return "That doesn't look like a valid web address.";
	}
	if (!hints.privateDestinations) {
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (isLocalHostname(host) || isNonPublicAddress(host)) {
			return "Local and private network addresses can't be opened through this Deblocker server.";
		}
	}
	const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
	if (hints.ports !== "any" && !hints.ports.includes(port)) {
		return `This server only allows connections to port${hints.ports.length === 1 ? "" : "s"} ${hints.ports.join(", ")}.`;
	}
	return null;
}

/** Short label for a tab: the page title if there is one, otherwise the hostname without "www.". */
export function hostLabel(href: string): string {
	try {
		return new URL(href).hostname.replace(/^www\./, "") || href;
	} catch {
		return href;
	}
}
