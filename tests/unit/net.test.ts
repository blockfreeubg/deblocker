import { describe, expect, it } from "vitest";
import { clientKey, isLocalHostname, isNonPublicAddress } from "../../src/shared/net.js";

describe("isNonPublicAddress", () => {
	it.each([
		"0.0.0.0",
		"10.1.2.3",
		"100.64.0.1",
		"127.0.0.1",
		"127.255.255.254",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"198.18.0.1",
		"224.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"[::1]",
		"fe80::1",
		"fe80::1%eth0",
		"fc00::1",
		"fd12:3456::1",
		"ff02::1",
		"::ffff:127.0.0.1",
		"::ffff:10.0.0.1",
		"::ffff:7f00:1",
		"64:ff9b::a00:1",
		"2001:db8::1",
		"2002:c0a8:0101::1",
	])("flags %s", (address) => {
		expect(isNonPublicAddress(address)).toBe(true);
	});

	it.each(["1.1.1.1", "8.8.8.8", "93.184.215.14", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111", "::ffff:1.1.1.1", "2002:0101:0101::1"])(
		"allows public %s",
		(address) => {
			expect(isNonPublicAddress(address)).toBe(false);
		},
	);

	it("ignores hostnames and garbage", () => {
		expect(isNonPublicAddress("example.com")).toBe(false);
		expect(isNonPublicAddress("1.2.3")).toBe(false);
		expect(isNonPublicAddress("1:2:3")).toBe(false);
	});
});

describe("isLocalHostname", () => {
	it.each(["localhost", "LOCALHOST.", "app.localhost", "printer.local", "metadata.google.internal", "nas.home.arpa"])("flags %s", (host) => {
		expect(isLocalHostname(host)).toBe(true);
	});
	it.each(["example.com", "localhost.example.com", "local.example"])("allows %s", (host) => {
		expect(isLocalHostname(host)).toBe(false);
	});
});

describe("clientKey", () => {
	it("groups IPv6 clients by /64 and unwraps IPv4-mapped addresses", () => {
		expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
		expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
		expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
		expect(clientKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
		expect(clientKey("unknown")).toBe("unknown");
	});
});
