import type { PolicyDecisionResponse, PublicConfig, SessionState } from "../../../shared/public-config.js";

/** The app is always served from its base directory, so every URL is resolved relative to it. */
export const BASE_URL = new URL("./", location.href);
export const BASE_PATH = BASE_URL.pathname;

export function appUrl(path: string): string {
	return new URL(path, BASE_URL).href;
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(appUrl(path), { credentials: "same-origin", cache: "no-store", ...init });
	const body = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new ApiError(body.error ?? `Request failed (${response.status})`, response.status);
	return body;
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export const api = {
	config: () => getJson<PublicConfig>("api/config"),
	session: () => getJson<SessionState>("api/session"),
	unlock: (key: string) =>
		getJson<SessionState>("api/session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key }),
		}),
	lock: () => getJson<SessionState>("api/session", { method: "DELETE" }),
	health: () => getJson<{ status: string }>("api/health"),
	policy: (url: string) => getJson<PolicyDecisionResponse>(`api/policy?url=${encodeURIComponent(url)}`),
};
