import type { LogLevel } from "./config.js";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
	error(message: string, ...details: unknown[]): void;
	warn(message: string, ...details: unknown[]): void;
	info(message: string, ...details: unknown[]): void;
	debug(message: string, ...details: unknown[]): void;
	enabled(level: LogLevel): boolean;
}

export function createLogger(level: LogLevel): Logger {
	const threshold = ORDER[level];
	const write = (target: LogLevel, message: string, details: unknown[]) => {
		if (ORDER[target] > threshold) return;
		const line = `${new Date().toISOString()} ${target.toUpperCase().padEnd(5)} ${message}`;
		const sink = target === "error" ? console.error : target === "warn" ? console.warn : console.log;
		sink(line, ...details);
	};
	return {
		error: (message, ...details) => write("error", message, details),
		warn: (message, ...details) => write("warn", message, details),
		info: (message, ...details) => write("info", message, details),
		debug: (message, ...details) => write("debug", message, details),
		enabled: (target) => ORDER[target] <= threshold,
	};
}
