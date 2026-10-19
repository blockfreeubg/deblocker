import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

export interface RunningApp {
	url: string;
	output: () => string;
	stop(): Promise<void>;
}

/** Starts the built server (dist/) as a child process with the given environment. */
export async function startApp(env: Record<string, string>): Promise<RunningApp> {
	if (!existsSync(path.join(root, "dist/server/index.js"))) throw new Error('Run "npm run build" before the end-to-end tests.');
	const port = await freePort();
	let output = "";
	const child: ChildProcess = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: root,
		env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LOG_LEVEL: "warn", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout!.on("data", (chunk) => (output += chunk));
	child.stderr!.on("data", (chunk) => (output += chunk));
	const base = env.BASE_PATH ? `/${env.BASE_PATH.replace(/^\/|\/$/g, "")}/`.replace("//", "/") : "/";
	const url = `http://localhost:${port}${base}`;
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
		try {
			const response = await fetch(`${url}api/health`);
			if (response.ok) break;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return {
		url,
		output: () => output,
		stop: () =>
			new Promise((resolve) => {
				if (child.exitCode !== null) return resolve();
				child.once("exit", () => resolve());
				child.kill("SIGTERM");
			}),
	};
}

export function chromiumPath(): string | undefined {
	const candidates = [process.env.CHROMIUM_PATH, "/opt/pw-browsers/chromium"].filter(Boolean) as string[];
	return candidates.find((candidate) => existsSync(candidate));
}
