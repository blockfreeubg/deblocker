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
import { loadSession, loadSettings, saveSession, saveSettings, type Settings } from "./lib/storage.js";
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
				return null;
			} catch (error) {
				return error instanceof Error ? error.message : "Couldn't check the key.";
			}
		},
	});

	const settingsView = new SettingsView(
		{
			change: (patch) => {
				settings = { ...settings, ...patch };
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

	home.setLocked(isLocked());
	const params = new URLSearchParams(location.search);
	const initial = params.get("url") ?? params.get("q");
	if (initial !== null) history.replaceState(null, "", BASE_PATH);
	browser.restore(loadSession(), isLocked() ? null : initial);

	installShortcuts(browser);
	void checkBackend();
}

function installShortcuts(browser: Browser) {
	const handler = (event: KeyboardEvent) => {
		const target = event.target as HTMLElement | null;
		const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
		const key = event.key;

		if ((event.ctrlKey || event.metaKey) && !event.altKey && key.toLowerCase() === "l") {
			event.preventDefault();
			browser.focusOmnibox();
			return;
		}
		if (key === "F6") {
			event.preventDefault();
			browser.focusOmnibox();
			return;
		}
		if (event.altKey && !event.ctrlKey && !event.metaKey) {
			const lower = key.toLowerCase();
			let handled = true;
			if (lower === "t" || event.code === "KeyT") browser.newTab();
			else if (lower === "w" || event.code === "KeyW") browser.closeActive();
			else if (key === "ArrowLeft") browser.back();
			else if (key === "ArrowRight") browser.forward();
			else if (lower === "r" || event.code === "KeyR") browser.reload();
			else if (key === "Home") browser.home();
			else if (/^Digit[1-9]$/.test(event.code)) browser.selectIndex(Number(event.code.slice(5)) - 1);
			else handled = false;
			if (handled) event.preventDefault();
			return;
		}
		if (key === "/" && !typing && browser.activePlace?.kind === "page" && browser.activePlace.page === "home") {
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
