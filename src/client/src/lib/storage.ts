import type { QuickLink } from "../../../shared/public-config.js";

export const THEMES = [
	{ id: "glacier", name: "Glacier", swatch: ["hsl(222 18% 10%)", "hsl(190 80% 60%)"] },
	{ id: "violet", name: "Violet", swatch: ["hsl(250 16% 10%)", "hsl(262 85% 74%)"] },
	{ id: "ember", name: "Ember", swatch: ["hsl(220 12% 10%)", "hsl(24 90% 63%)"] },
	{ id: "mint", name: "Mint", swatch: ["hsl(196 16% 10%)", "hsl(155 58% 56%)"] },
	{ id: "rose", name: "Rose", swatch: ["hsl(250 12% 10%)", "hsl(340 80% 71%)"] },
	{ id: "mono", name: "Mono", swatch: ["hsl(220 4% 10%)", "hsl(220 0% 90%)"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export interface Settings {
	theme: ThemeId;
	backdrop: boolean;
	/** Search URL template chosen by this visitor, or null to use the server default. */
	searchEngine: string | null;
	/** Quick links customised by this visitor, or null to use the server defaults. */
	quickLinks: QuickLink[] | null;
}

const SETTINGS_KEY = "deblocker:settings";
const SESSION_KEY = "deblocker:session";

const DEFAULTS: Settings = { theme: "glacier", backdrop: true, searchEngine: null, quickLinks: null };

function isQuickLink(value: unknown): value is QuickLink {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as QuickLink).title === "string" &&
		typeof (value as QuickLink).url === "string" &&
		/^https?:\/\//i.test((value as QuickLink).url)
	);
}

/** Settings are a per-browser convenience; storage can be unavailable (private mode), so every access is guarded. */
export function loadSettings(): Settings {
	try {
		const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
		return {
			theme: THEMES.some((t) => t.id === raw.theme) ? (raw.theme as ThemeId) : DEFAULTS.theme,
			backdrop: typeof raw.backdrop === "boolean" ? raw.backdrop : DEFAULTS.backdrop,
			searchEngine: typeof raw.searchEngine === "string" && raw.searchEngine.includes("%s") ? raw.searchEngine : null,
			quickLinks: Array.isArray(raw.quickLinks) ? raw.quickLinks.filter(isQuickLink).slice(0, 24) : null,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveSettings(settings: Settings): void {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// Storage unavailable: settings simply won't persist.
	}
}

export interface SavedTab {
	url: string;
}

export interface SavedSession {
	tabs: SavedTab[];
	active: number;
}

/** Open tabs survive a reload of Deblocker itself (sessionStorage is per browser tab). */
export function loadSession(): SavedSession | null {
	try {
		const raw = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as SavedSession | null;
		if (!raw || !Array.isArray(raw.tabs)) return null;
		const tabs = raw.tabs.filter((tab) => typeof tab?.url === "string").slice(0, 12);
		return tabs.length ? { tabs, active: Math.min(Math.max(0, Number(raw.active) || 0), tabs.length - 1) } : null;
	} catch {
		return null;
	}
}

export function saveSession(session: SavedSession | null): void {
	try {
		if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
		else sessionStorage.removeItem(SESSION_KEY);
	} catch {
		// ignore
	}
}
