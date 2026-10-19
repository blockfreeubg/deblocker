import http from "node:http";
import type { Socket } from "node:net";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

async function main() {
	let config;
	try {
		config = loadConfig();
	} catch (error) {
		if (error instanceof ConfigError) {
			console.error(error.message);
			process.exit(1);
		}
		throw error;
	}

	const logger = createLogger(config.logLevel);
	const server = http.createServer();
	const { app, gateway, warm } = await createApp(config, logger, server);
	server.on("request", app);

	server.on("upgrade", (request, socket, head) => {
		if (gateway.handleUpgrade(request, socket, head)) return;
		// In development Vite registers its own upgrade listener for hot reload; leave those sockets alone.
		if (!config.dev) socket.destroy();
	});

	const connections = new Set<Socket>();
	server.on("connection", (socket) => {
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
	});

	server.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EADDRINUSE") logger.error(`Port ${config.port} is already in use. Set PORT to a free port.`);
		else logger.error("Server error:", error);
		process.exit(1);
	});

	server.listen(config.port, config.host, () => {
		const shownHost = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
		logger.info(`Deblocker is running at http://${shownHost}:${config.port}${config.basePath}`);
		logger.info(`Wisp endpoint: ${gateway.path} | transport: ${config.transport} | private destinations: ${config.destinations.allowPrivate ? "ALLOWED" : "blocked"}`);
		if (config.access.key) logger.info("Access key protection is enabled");
		if (config.destinations.allowPrivate) logger.warn("ALLOW_PRIVATE_DESTINATIONS is on: visitors can reach this machine's local network. Use only for development.");
		warm().catch((error) => logger.warn("Could not pre-compress engine files:", error));
	});

	let shuttingDown = false;
	const shutdown = (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info(`${signal} received, shutting down`);
		gateway.closeAll();
		server.close(() => process.exit(0));
		for (const socket of connections) socket.destroy();
		setTimeout(() => process.exit(0), 5000).unref();
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
