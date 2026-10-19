import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/home.css";
import "./styles/components.css";
import "./styles/pages.css";

import { SEARCH_ENGINES, type PublicConfig, type QuickLink, type SessionState } from "../../shared/public-config.js";
import type { DestinationHints, InternalPage } from "../../shared/url.js";
import { Browser, type Place } from "./app/browser.js";
import { createScramjetEngine } from "./engine/scramjet.js";
import { api, ApiError, BASE_PATH } from "./lib/api.js";
import { $ } from "./lib/dom.js";
import { loadSession, loadSettings, saveSession, saveSettings, SETTINGS_KEY, type Settings } from "./lib/storage.js";
import { renderAbout } from "./ui/about.js";
import { HomeView } from "./ui/home.js";
import { SettingsView } from "./ui/settings.js";
import { dismissToast, toast } from "./ui/toast.js";

let settings: Settings = loadSettings();
let config: PublicConfig | null = null;
let session: SessionState = { required: false, authenticated: true };

function applyAppearance() {
	const root = document.documentElement;
	root.dataset.theme = settings.theme;
	root.dataset.backdrop = settings.backdrop ? "on" : "off";
	const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
	if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
}

/** Scatters a deterministic set of stars over the backdrop sky. */
function drawStars() {
	const group = document.querySelector(".backdrop-stars");
	if (!group) return;
	let seed = 0x9e3779b9;
	const random = () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const ns = "http://www.w3.org/2000/svg";
	for (let i = 0; i < 110; i++) {
		const star = document.createElementNS(ns, "circle");
		star.setAttribute("cx", (random() * 1600).toFixed(1));
		star.setAttribute("cy", (random() * random() * 560).toFixed(1));
		star.setAttribute("r", (0.5 + random() * 1.1).toFixed(2));
		star.setAttribute("opacity", (0.15 + random() * 0.55).toFixed(2));
		group.append(star);
	}
}

const searchTemplate = () => settings.searchEngine ?? config?.searchEngine ?? SEARCH_ENGINES[0]!.template;
const quickLinks = (): QuickLink[] => settings.quickLinks ?? config?.quickLinks ?? [];
const hints = (): DestinationHints => ({
	ports: config?.policy.ports ?? [80, 443],
	privateDestinations: config?.policy.privateDestinations ?? false,
});
const isLocked = () => session.required && !session.authenticated;

async function main() {
	applyAppearance();
	drawStars();

	const statusChip = $("statusChip");
	const statusText = $("statusText");
	const setStatus = (state: "checking" | "online" | "offline", text: string) => {
		statusChip.dataset.state = state;
		statusText.textContent = text;
		statusChip.title = state === "offline" ? "The proxy backend is unreachable. Click to retry." : `Proxy backend: ${text}`;
	};

	try {
		[config, session] = await Promise.all([api.config(), api.session()]);
	} catch (error) {
		setStatus("offline", "server unreachable");
		toast({
			title: "Can't reach the Deblocker server",
			message: error instanceof ApiError ? error.message : "Check your connection, then reload.",
			tone: "error",
			actions: [{ label: "Reload", icon: "rotate-cw", run: () => location.reload() }],
		});
	}

	const engine = createScramjetEngine({ base: BASE_PATH, transport: config?.transport ?? "libcurl" });

	/**
	 * An access-key session can end while Deblocker is open (it expired, the server restarted with a new
	 * secret, or the visitor signed out elsewhere). The tunnel then refuses connections, which would
	 * otherwise look like the backend being down.
	 */
	const refreshLock = async (): Promise<boolean> => {
		const latest = await api.session().catch(() => null);
		if (!latest) return false;
		session = latest;
		if (!isLocked()) return false;
		home.setLocked(true);
		setStatus("checking", "locked");
		dismissToast("backend");
		return true;
	};

	const checkBackend = async (announce = false) => {
		if (isLocked()) {
			setStatus("checking", "locked");
			return;
		}
		setStatus("checking", "connecting…");
		try {
			await engine.ready();
		} catch (error) {
			setStatus("offline", "engine failed");
			toast({ key: "engine", title: "The proxy engine couldn't start", message: error instanceof Error ? error.message : String(error), tone: "error" });
			return;
		}
		const ok = await engine.checkBackend();
		if (!ok && (await refreshLock())) {
			browser.lock();
			return;
		}
		setStatus(ok ? "online" : "offline", ok ? "online" : "backend unreachable");
		if (ok) dismissToast("backend");
		else
			toast({
				key: "backend",
				title: "Proxy backend unreachable",
				message: "Pages can't load until the server's WebSocket endpoint responds. It may be down, or a network may block WebSockets.",
				tone: "error",
				actions: [{ label: "Retry", icon: "rotate-cw", run: () => void checkBackend(true) }],
			});
		if (ok && announce) toast({ title: "Connected", message: "The proxy backend is reachable again.", timeout: 3000 });
	};
	statusChip.addEventListener("click", () => void checkBackend(true));

	const home = new HomeView({
		submit: (input) => {
			const error = browser.submit(input);
			home.showMessage(error);
			if (!error) home.clear();
		},
		openLink: (url, newTab) => browser.open({ kind: "web", url }, { newTab }),
		editLinks: () => {
			browser.openPage("settings");
			settingsView.show("links");
		},
		unlock: async (key) => {
			try {
				session = await api.unlock(key);
				home.setLocked(isLocked());
				void checkBackend();
				home.focus();
				browser.resume();
				return null;
			} catch (error) {
				return error instanceof Error ? error.message : "Couldn't check the key.";
			}
		},
	});

	const settingsView = new SettingsView(
		{
			change: (patch) => {
				// Start from what is stored, so a change here doesn't undo one made in another window.
				settings = { ...loadSettings(), ...patch };
				saveSettings(settings);
				applyAppearance();
				home.renderLinks(quickLinks());
			},
			clearData: async () => {
				if (!window.confirm("Close all tabs and remove cookies, storage and cached files saved by proxied sites?")) return;
				browser.closeAll();
				saveSession(null);
				try {
					await engine.clearSiteData();
					toast({ title: "Site data cleared", message: "Cookies, storage and caches from proxied sites were removed.", timeout: 4000 });
				} catch (error) {
					toast({ title: "Couldn't clear everything", message: error instanceof Error ? error.message : String(error), tone: "error" });
				}
				browser.newTab({ kind: "page", page: "settings" });
				settingsView.show("data");
			},
			signOut: async () => {
				try {
					session = await api.lock();
				} catch {
					session = { required: true, authenticated: false };
				}
				browser.closeAll();
				saveSession(null);
				browser.newTab();
				home.setLocked(isLocked());
				setStatus("checking", "locked");
			},
		},
		() => settings,
		() => config,
		quickLinks,
		() => session,
	);

	const railButtons = [...document.querySelectorAll<HTMLButtonElement>(".rail-btn")];
	const browser = new Browser({
		engine,
		searchTemplate,
		hints,
		isLocked,
		diagnose: async (error) => {
			if (error.kind === "blocked" || error.kind === "tls" || error.kind === "timeout") return error;
			const decision = await api.policy(error.url).catch(() => null);
			if (decision && !decision.allowed) return { ...error, kind: "blocked" };
			// "Couldn't connect" can mean the backend or the destination; if the backend answers, it was the site.
			if (error.kind === "transport" && engine.status === "ready" && (await engine.checkBackend())) return { ...error, kind: "unreachable" };
			if (error.kind === "transport" && (await refreshLock())) return { ...error, kind: "locked" };
			return error;
		},
		showPage: (page: InternalPage) => {
			if (page === "home") {
				home.renderLinks(quickLinks());
				// Focus the search box like a browser's new tab page, unless the visitor is typing elsewhere
				// (and not on touch screens, where focusing would pop up the keyboard every time).
				const focused = document.activeElement;
				const typing = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement;
				if (!typing && matchMedia("(pointer: fine)").matches) home.focus();
			} else if (page === "settings") settingsView.render();
			else renderAbout(config);
		},
		sessionChanged: (saved) => saveSession(saved),
		activeChanged: (place: Place | null) => {
			const current = place?.kind === "page" ? place.page : null;
			for (const button of railButtons) {
				if (button.dataset.nav === current) button.setAttribute("aria-current", "page");
				else button.removeAttribute("aria-current");
			}
		},
	});

	for (const button of railButtons) {
		button.addEventListener("click", () => {
			const target = button.dataset.nav;
			if (target === "new-tab") browser.newTab();
			else if (target === "home" || target === "settings" || target === "about") browser.openPage(target);
		});
	}

	// Settings changed in another Deblocker window apply here too.
	window.addEventListener("storage", (event) => {
		if (event.key !== SETTINGS_KEY && event.key !== null) return;
		settings = loadSettings();
		applyAppearance();
		home.renderLinks(quickLinks());
		const place = browser.activePlace;
		if (place?.kind === "page" && place.page === "settings") settingsView.render();
	});

	home.setLocked(isLocked());
	const params = new URLSearchParams(location.search);
	const initial = params.get("url") ?? params.get("q");
	if (initial !== null) history.replaceState(history.state, "", BASE_PATH);
	// A popup opened by a proxied page inherits a copy of the opener's sessionStorage; it should show
	// just the page it was opened for, not a duplicate of every tab in the other window.
	const popup = initial !== null && window.opener !== null;
	browser.restore(popup ? null : loadSession(), isLocked() ? null : initial);

	installShortcuts(browser);
	installBackGuard(browser);
	void checkBackend();
}

/**
 * Keeps the browser's own Back (button, mouse button, swipe, or a page calling history.back()) inside
 * Deblocker: an extra history entry sits on top of the app, and stepping back onto the entry below it
 * becomes Back in the active tab. With nothing to go back to in the tab, Back leaves as usual.
 */
function installBackGuard(browser: Browser) {
	const state = () => (history.state as { dbk?: string } | null)?.dbk;
	const arm = () => {
		if (state() === "top") return;
		history.replaceState({ dbk: "base" }, "", BASE_PATH);
		history.pushState({ dbk: "top" }, "", BASE_PATH);
	};
	// Browsers skip history entries a page adds before the visitor has interacted with it, so the
	// entry is added on the first click or key press instead of at startup.
	window.addEventListener("pointerup", arm, true);
	window.addEventListener("keydown", arm, true);
	window.addEventListener("popstate", () => {
		if (state() !== "base") return;
		if (browser.canGoBack) {
			history.forward();
			browser.back();
		} else history.back();
	});
}

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** Whether a key goes to something that takes text. Duck-typed, because events forwarded from proxied pages come from another realm. */
function isEditable(target: EventTarget | null): boolean {
	const element = target as { closest?: (selectors: string) => unknown } | null;
	return typeof element?.closest === "function" && element.closest(EDITABLE) !== null;
}

/** The action for an Alt/Option shortcut, or null when the key belongs to the page or the text field. */
function altShortcut(event: KeyboardEvent, editable: boolean, browser: Browser): (() => void) | null {
	const { key, code } = event;
	if (key === "ArrowLeft" || key === "ArrowRight") {
		// In text fields Alt/Option+Arrow moves by word, and with Shift it extends the selection.
		if (editable || event.shiftKey) return null;
		return key === "ArrowLeft" ? () => browser.back() : () => browser.forward();
	}
	if (event.shiftKey) return null;
	if (key === "Home") return editable ? null : () => browser.home();
	// On macOS, Option changes the character (Option+T types "†"), so the physical key is used there,
	// but only outside text fields, where Option+letter is how those characters are typed.
	const physical = IS_MAC && !editable;
	const letter = /^[a-z]$/i.test(key) ? key.toLowerCase() : physical && /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : null;
	if (letter === "t") return () => browser.newTab();
	if (letter === "w") return () => browser.closeActive();
	if (letter === "r") return () => browser.reload();
	const digit = /^[1-9]$/.test(key) ? Number(key) : physical && /^Digit[1-9]$/.test(code) ? Number(code.slice(5)) : 0;
	if (digit && digit <= browser.tabCount) return () => browser.selectIndex(digit - 1);
	return null;
}

function installShortcuts(browser: Browser) {
	const handler = (event: KeyboardEvent) => {
		if (event.isComposing) return;
		const editable = isEditable(event.target);
		const key = event.key;
		const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

		if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key.toLowerCase() === "l") {
			event.preventDefault();
			browser.focusOmnibox();
			return;
		}
		if (key === "F6" && plain) {
			event.preventDefault();
			browser.focusOmnibox();
			return;
		}
		// AltGr is reported as Ctrl+Alt, so requiring no Ctrl keeps AltGr characters typeable.
		if (event.altKey && !event.ctrlKey && !event.metaKey) {
			const action = altShortcut(event, editable, browser);
			if (action) {
				event.preventDefault();
				action();
			}
			return;
		}
		// Shift is allowed: on some keyboard layouts "/" needs it.
		if (key === "/" && !event.altKey && !event.ctrlKey && !event.metaKey && !editable && browser.activePlace?.kind === "page" && browser.activePlace.page === "home") {
			event.preventDefault();
			$("homeInput").focus();
		}
	};
	window.addEventListener("keydown", handler);
	// Let shortcuts work while a proxied page has focus, too (frames are same-origin).
	(window as unknown as { __deblockerShortcuts?: (event: KeyboardEvent) => void }).__deblockerShortcuts = handler;
}

main().catch((error) => {
	console.error(error);
	toast({ title: "Deblocker failed to start", message: error instanceof Error ? error.message : String(error), tone: "error" });
});
