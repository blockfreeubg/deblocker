import { server as wispServer } from "@mercuryworkshop/wisp-js/server";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { createLogger } from "../../src/server/logger.js";
import { DestinationPolicy } from "../../src/server/policy.js";
import { configureWisp } from "../../src/server/wisp.js";

const logger = createLogger("error");

function configure(env: Record<string, string>, records: Array<{ address: string; family: number }>) {
	const config = loadConfig({ LOG_LEVEL: "error", ...env }, []);
	configureWisp(config, new DestinationPolicy(config.destinations), logger, async () => records);
	return wispServer.options;
}

describe("configureWisp", () => {
	it("applies safe defaults to wisp-js", () => {
		const options = configure({}, []);
		expect(options.allow_udp_streams).toBe(false);
		expect(options.allow_private_ips).toBe(false);
		expect(options.allow_loopback_ips).toBe(false);
		expect(options.port_whitelist).toEqual([80, 443]);
		expect(options.hostname_whitelist).toBeNull();
		expect(options.stream_limit_per_host).toBe(-1);
	});

	it("blocks hostnames through the policy matcher", () => {
		const options = configure({ DESTINATION_BLOCKLIST: "bad.example" }, []);
		const blocked = (host: string) => options.hostname_blacklist!.some((matcher) => matcher.test(host));
		expect(blocked("bad.example")).toBe(true);
		expect(blocked("cdn.bad.example")).toBe(true);
		expect(blocked("good.example")).toBe(false);
		expect(blocked("::ffff:10.0.0.1")).toBe(true);
		expect(blocked("fd00::1")).toBe(true);
	});

	it("refuses names that only resolve to private addresses (DNS rebinding)", async () => {
		const options = configure({}, [{ address: "127.0.0.1", family: 4 }]);
		const resolve = options.dns_method as (host: string) => Promise<string>;
		await expect(resolve("rebind.example")).rejects.toThrow(/non-public/);
	});

	it("connects to the first public address of a mixed answer", async () => {
		const options = configure({}, [
			{ address: "10.0.0.8", family: 4 },
			{ address: "93.184.215.14", family: 4 },
		]);
		const resolve = options.dns_method as (host: string) => Promise<string>;
		await expect(resolve("mixed.example")).resolves.toBe("93.184.215.14");
	});

	it("allows private resolution only in development mode", async () => {
		const options = configure({ ALLOW_PRIVATE_DESTINATIONS: "true" }, [{ address: "192.168.1.5", family: 4 }]);
		const resolve = options.dns_method as (host: string) => Promise<string>;
		await expect(resolve("nas.example")).resolves.toBe("192.168.1.5");
		expect(options.port_whitelist).toEqual([80, 443]);
	});
});
