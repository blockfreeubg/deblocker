/**
 * Address classification used to keep the proxy away from loopback, private and other
 * non-public networks. Pure functions so they can run in Node and in the browser.
 */

function parseIPv4(address: string): number[] | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
	return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function inV4Range(octets: number[], base: [number, number, number, number], bits: number): boolean {
	const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
	const baseValue = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (value & mask) === (baseValue & mask);
}

const NON_PUBLIC_V4: Array<[[number, number, number, number], number]> = [
	[[0, 0, 0, 0], 8], // "this" network
	[[10, 0, 0, 0], 8], // private
	[[100, 64, 0, 0], 10], // carrier-grade NAT
	[[127, 0, 0, 0], 8], // loopback
	[[169, 254, 0, 0], 16], // link-local (includes cloud metadata endpoints)
	[[172, 16, 0, 0], 12], // private
	[[192, 0, 0, 0], 24], // IETF protocol assignments
	[[192, 0, 2, 0], 24], // documentation
	[[192, 88, 99, 0], 24], // 6to4 relay anycast
	[[192, 168, 0, 0], 16], // private
	[[198, 18, 0, 0], 15], // benchmarking
	[[198, 51, 100, 0], 24], // documentation
	[[203, 0, 113, 0], 24], // documentation
	[[224, 0, 0, 0], 4], // multicast
	[[240, 0, 0, 0], 4], // reserved + broadcast
];

function expandIPv6(address: string): number[] | null {
	let input = address.toLowerCase();
	if (input.startsWith("[") && input.endsWith("]")) input = input.slice(1, -1);
	const zone = input.indexOf("%");
	if (zone !== -1) input = input.slice(0, zone);
	if (!input.includes(":")) return null;

	// An embedded IPv4 tail (e.g. ::ffff:127.0.0.1) becomes two hextets.
	const lastColon = input.lastIndexOf(":");
	const tail = input.slice(lastColon + 1);
	if (tail.includes(".")) {
		const v4 = parseIPv4(tail);
		if (!v4) return null;
		input = `${input.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
	}

	const halves = input.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 && head.length !== 8) return null;
	if (halves.length === 2 && missing < 1) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
	if (groups.length !== 8) return null;
	const values = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
	return values.every((value) => !Number.isNaN(value)) ? values : null;
}

export function isIPv4Literal(value: string): boolean {
	return parseIPv4(value) !== null;
}

export function isIPv6Literal(value: string): boolean {
	return expandIPv6(value) !== null;
}

/** True when the address is not a globally routable unicast address. */
export function isNonPublicAddress(address: string): boolean {
	const v4 = parseIPv4(address);
	if (v4) return NON_PUBLIC_V4.some(([base, bits]) => inV4Range(v4, base, bits));

	const v6 = expandIPv6(address);
	if (!v6) return false;
	const [a, b, c, d, e, f, g, h] = v6 as [number, number, number, number, number, number, number, number];
	const embeddedV4 = [g >> 8, g & 0xff, h >> 8, h & 0xff].join(".");

	if (v6.every((group) => group === 0)) return true; // ::
	if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) return true; // ::1
	if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) {
		return isNonPublicAddress(embeddedV4); // IPv4-mapped / IPv4-compatible
	}
	if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return isNonPublicAddress(embeddedV4); // NAT64
	if ((a & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
	if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
	if ((a & 0xffc0) === 0xfec0) return true; // deprecated site-local
	if ((a & 0xff00) === 0xff00) return true; // multicast
	if (a === 0x2001 && b === 0x0db8) return true; // documentation
	if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // discard prefix
	if (a === 0x2002) return isNonPublicAddress([b >> 8, b & 0xff, c >> 8, c & 0xff].join(".")); // 6to4
	return false;
}

/** Hostnames that always refer to the local machine or local network. */
export function isLocalHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host.endsWith(".home.arpa") ||
		host === "ip6-localhost" ||
		host === "ip6-loopback"
	);
}

/**
 * Key for per-client rate limits: IPv4 addresses as-is (IPv4-mapped IPv6 unwrapped) and IPv6
 * addresses by their /64 prefix, since a single subscriber or server usually controls a whole /64.
 */
export function clientKey(address: string): string {
	const v6 = expandIPv6(address);
	if (!v6) return address;
	if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
		return [v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff].join(".");
	}
	return `${v6
		.slice(0, 4)
		.map((group) => group.toString(16))
		.join(":")}::/64`;
}
