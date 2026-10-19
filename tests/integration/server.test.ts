import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_BLOCKED, openWebSocket, startEchoTarget, startServer, wispStream, type TestServer } from "./helpers.js";

let target: { port: number; close(): Promise<void> };

beforeAll(async () => {
	target = await startEchoTarget();
});

afterAll(async () => {
	await target.close();
});

const request = (port: number) => `GET /hello HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`;

describe("HTTP API", () => {
	let server: TestServer;
	beforeAll(async () => {
		server = await startServer({ ACCESS_KEY: "open sesame", SESSION_SECRET: "k".repeat(40) });
	});
	afterAll(() => server.close());

	it("reports health", async () => {
		const response = await fetch(server.url("api/health"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "ok" });
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-powered-by")).toBeNull();
	});

	it("exposes public configuration without secrets", async () => {
		const text = await (await fetch(server.url("api/config"))).text();
		const config = JSON.parse(text);
		expect(config).toMatchObject({ transport: "libcurl", accessKeyRequired: true });
		expect(config.engine.scramjet).toMatch(/^2\./);
		expect(text).not.toContain("open sesame");
		expect(text).not.toContain("k".repeat(40));
	});

	it("returns JSON 404s for unknown API routes", async () => {
		const response = await fetch(server.url("api/nope"));
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not found" });
	});

	it("serves engine files with the right types, compression and caching", async () => {
		const wasm = await fetch(server.url("engine/scramjet.wasm"), { headers: { "accept-encoding": "br" } });
		expect(wasm.status).toBe(200);
		expect(wasm.headers.get("content-type")).toBe("application/wasm");
		expect(wasm.headers.get("content-encoding")).toBe("br");
		const etag = wasm.headers.get("etag")!;
		const bytes = new Uint8Array(await wasm.arrayBuffer());
		expect([...bytes.slice(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]); // fetch decodes br; this is the wasm magic number
		const cached = await fetch(server.url("engine/scramjet.wasm"), { headers: { "if-none-match": etag } });
		expect(cached.status).toBe(304);
		for (const file of ["scramjet.js", "controller.api.js", "controller.inject.js", "controller.sw.js", "scramjet-utils.js", "transport.js"]) {
			const response = await fetch(server.url(`engine/${file}`));
			expect(response.status, file).toBe(200);
			expect(response.headers.get("content-type")).toContain("javascript");
		}
		expect((await fetch(server.url("engine/../package.json"))).status).toBe(404);
		expect((await fetch(server.url("engine/secret.js"))).status).toBe(404);
	});

	it("requires the access key before opening Wisp connections", async () => {
		const origin = { origin: server.origin };
		const denied = await openWebSocket(server.wispUrl, origin);
		expect(denied).toEqual({ opened: false, status: 401 });

		expect(await (await fetch(server.url("api/session"))).json()).toEqual({ required: true, authenticated: false });
		const wrong = await fetch(server.url("api/session"), { method: "POST", headers: { "content-type": "application/json", ...origin }, body: JSON.stringify({ key: "nope" }) });
		expect(wrong.status).toBe(401);

		const right = await fetch(server.url("api/session"), {
			method: "POST",
			headers: { "content-type": "application/json", ...origin },
			body: JSON.stringify({ key: "open sesame" }),
		});
		expect(right.status).toBe(200);
		const cookie = right.headers.get("set-cookie")!.split(";")[0]!;
		expect(cookie).toMatch(/^deblocker_session=v1\./);
		expect(await (await fetch(server.url("api/session"), { headers: { cookie } })).json()).toEqual({ required: true, authenticated: true });

		const allowed = await openWebSocket(server.wispUrl, { ...origin, cookie });
		expect(allowed.opened).toBe(true);
		if (allowed.opened) allowed.socket.close();
	});

	it("rejects cross-site session requests", async () => {
		const response = await fetch(server.url("api/session"), {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://evil.example" },
			body: JSON.stringify({ key: "open sesame" }),
		});
		expect(response.status).toBe(403);
	});

	it("rate-limits access key guesses", async () => {
		let limited = false;
		for (let i = 0; i < 12 && !limited; i++) {
			const response = await fetch(server.url("api/session"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: `guess-${i}` }) });
			limited = response.status === 429;
		}
		expect(limited).toBe(true);
	});
});

describe("Wisp gateway with default (public-only) policy", () => {
	let server: TestServer;
	beforeAll(async () => {
		server = await startServer({ MAX_CONNECTIONS_PER_IP: "2" });
	});
	afterAll(() => server.close());

	it("rejects upgrades without a same-site Origin", async () => {
		expect(await openWebSocket(server.wispUrl)).toEqual({ opened: false, status: 403 });
		expect(await openWebSocket(server.wispUrl, { origin: "https://evil.example" })).toEqual({ opened: false, status: 403 });
	});

	it("refuses loopback and local destinations", async () => {
		const result = await openWebSocket(server.wispUrl, { origin: server.origin });
		expect(result.opened).toBe(true);
		if (!result.opened) return;
		for (const host of ["127.0.0.1", "localhost", "::ffff:127.0.0.1", "[::1]"]) {
			const stream = await wispStream(result.socket, host, target.port, { send: request(target.port) });
			expect(stream, host).toMatchObject({ kind: "closed", reason: HOST_BLOCKED });
			expect(stream.data).toBe("");
		}
		result.socket.close();
	});

	it("refuses ports outside ALLOWED_PORTS and UDP streams", async () => {
		const result = await openWebSocket(server.wispUrl, { origin: server.origin });
		if (!result.opened) throw new Error("expected connection");
		expect(await wispStream(result.socket, "example.com", 22)).toMatchObject({ kind: "closed", reason: HOST_BLOCKED });
		expect(await wispStream(result.socket, "example.com", 53, { udp: true })).toMatchObject({ kind: "closed", reason: HOST_BLOCKED });
		result.socket.close();
	});

	it("limits concurrent connections per IP", async () => {
		const first = await openWebSocket(server.wispUrl, { origin: server.origin });
		const second = await openWebSocket(server.wispUrl, { origin: server.origin });
		const third = await openWebSocket(server.wispUrl, { origin: server.origin });
		expect(first.opened && second.opened).toBe(true);
		expect(third).toEqual({ opened: false, status: 429 });
		for (const result of [first, second]) if (result.opened) result.socket.close();
	});
});

describe("Wisp gateway with private destinations enabled (development)", () => {
	let server: TestServer;
	beforeAll(async () => {
		server = await startServer({ ALLOW_PRIVATE_DESTINATIONS: "true", ALLOWED_PORTS: "*", DESTINATION_BLOCKLIST: "localhost" });
	});
	afterAll(() => server.close());

	it("relays a TCP stream to the destination", async () => {
		const result = await openWebSocket(server.wispUrl, { origin: server.origin });
		if (!result.opened) throw new Error("expected connection");
		const stream = await wispStream(result.socket, "127.0.0.1", target.port, { send: request(target.port) });
		expect(stream.data).toContain("HTTP/1.1 200 OK");
		expect(stream.data).toContain("target saw GET /hello");
		result.socket.close();
	});

	it("still applies the blocklist", async () => {
		const result = await openWebSocket(server.wispUrl, { origin: server.origin });
		if (!result.opened) throw new Error("expected connection");
		expect(await wispStream(result.socket, "localhost", target.port)).toMatchObject({ kind: "closed", reason: HOST_BLOCKED });
		result.socket.close();
	});
});

describe("sub-path deployment", () => {
	let server: TestServer;
	beforeAll(async () => {
		server = await startServer({ BASE_PATH: "/tools/deblocker" });
	});
	afterAll(() => server.close());

	it("mounts everything under BASE_PATH", async () => {
		expect(server.base).toBe("/tools/deblocker/");
		expect((await fetch(server.url("api/health"))).status).toBe(200);
		expect((await fetch(server.url("engine/scramjet.js"))).status).toBe(200);
		expect((await fetch(`${server.origin}/api/health`)).status).toBe(404);
		const bare = await fetch(`${server.origin}/tools/deblocker?url=x`, { redirect: "manual" });
		expect(bare.status).toBe(301);
		expect(bare.headers.get("location")).toBe("/tools/deblocker/?url=x");
		const root = await fetch(`${server.origin}/`, { redirect: "manual" });
		expect(root.headers.get("location")).toBe("/tools/deblocker/");
	});

	it("serves Wisp at the sub-path only", async () => {
		const ok = await openWebSocket(server.wispUrl, { origin: server.origin });
		expect(ok.opened).toBe(true);
		if (ok.opened) ok.socket.close();
		expect(await openWebSocket(`${server.origin.replace("http", "ws")}/wisp/`, { origin: server.origin })).toEqual({ opened: false, status: 0 });
	});
});
