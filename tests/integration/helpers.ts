import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { createLogger } from "../../src/server/logger.js";

export interface TestServer {
	origin: string;
	base: string;
	url(path: string): string;
	wispUrl: string;
	close(): Promise<void>;
}

/** Runs the real Express app + Wisp gateway (without the frontend) on an ephemeral port. */
export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
	const config = loadConfig({ LOG_LEVEL: "error", ...env }, []);
	const server = http.createServer();
	const { app, gateway } = await createApp(config, createLogger("error"), server, { frontend: false });
	server.on("request", app);
	server.on("upgrade", (req, socket, head) => {
		if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const origin = `http://127.0.0.1:${port}`;
	return {
		origin,
		base: config.basePath,
		url: (path) => `${origin}${config.basePath}${path}`,
		wispUrl: `ws://127.0.0.1:${port}${config.basePath}wisp/`,
		close: () =>
			new Promise((resolve) => {
				gateway.closeAll();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export async function startEchoTarget(): Promise<{ port: number; close(): Promise<void> }> {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/plain", connection: "close" });
		res.end(`target saw ${req.method} ${req.url}`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: (server.address() as AddressInfo).port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export type UpgradeResult = { opened: true; socket: WebSocket } | { opened: false; status: number };

export function openWebSocket(url: string, headers: Record<string, string> = {}): Promise<UpgradeResult> {
	return new Promise((resolve) => {
		const socket = new WebSocket(url, { headers });
		socket.binaryType = "nodebuffer";
		socket.once("open", () => resolve({ opened: true, socket }));
		socket.once("unexpected-response", (_req, res) => resolve({ opened: false, status: res.statusCode ?? 0 }));
		socket.once("error", () => resolve({ opened: false, status: 0 }));
	});
}

/* A minimal Wisp v1 client: enough to open one stream and read its result. */
const CONNECT = 0x01;
const DATA = 0x02;
const CLOSE = 0x04;

function packet(type: number, streamId: number, payload: Buffer): Buffer {
	const header = Buffer.alloc(5);
	header.writeUInt8(type, 0);
	header.writeUInt32LE(streamId, 1);
	return Buffer.concat([header, payload]);
}

export type StreamResult = { kind: "closed"; reason: number; data: string } | { kind: "timeout"; data: string };

/**
 * Opens a TCP (or UDP) stream through the Wisp connection, optionally sends `send`,
 * and resolves when the server closes the stream (with its close reason).
 */
export function wispStream(socket: WebSocket, host: string, port: number, options: { send?: string; udp?: boolean; timeoutMs?: number } = {}): Promise<StreamResult> {
	return new Promise((resolve) => {
		let data = "";
		const streamId = nextStreamId++;
		const timer = setTimeout(() => {
			socket.off("message", onMessage);
			resolve({ kind: "timeout", data });
		}, options.timeoutMs ?? 4000);
		const onMessage = (raw: Buffer) => {
			const type = raw.readUInt8(0);
			const id = raw.readUInt32LE(1);
			const payload = raw.subarray(5);
			if (id !== streamId) return;
			if (type === DATA) data += payload.toString("utf8");
			if (type === CLOSE) {
				clearTimeout(timer);
				socket.off("message", onMessage);
				resolve({ kind: "closed", reason: payload.readUInt8(0), data });
			}
		};
		socket.on("message", onMessage);
		// Wisp lets the client send CONNECT as soon as the WebSocket is open.
		const header = Buffer.alloc(3);
		header.writeUInt8(options.udp ? 0x02 : 0x01, 0);
		header.writeUInt16LE(port, 1);
		socket.send(packet(CONNECT, streamId, Buffer.concat([header, Buffer.from(host, "utf8")])));
		if (options.send) socket.send(packet(DATA, streamId, Buffer.from(options.send)));
	});
}

let nextStreamId = 1;

export const HOST_BLOCKED = 0x48;
