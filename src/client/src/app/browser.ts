import {
	explainBlockedDestination,
	hostLabel,
	resolveInput,
	type DestinationHints,
	type InternalPage,
} from "../../../shared/url.js";
import type { NavigationError, NavigationKind, ProxyEngine, ProxyFrame } from "../engine/types.js";
import { $, h, icon } from "../lib/dom.js";
import type { SavedSession } from "../lib/storage.js";
import { toast } from "../ui/toast.js";

export type Place = { kind: "page"; page: InternalPage } | { kind: "web"; url: string };

const MAX_TABS = 12;
const SLOW_LOAD_MS = 12_000;

const PAGE_TITLES: Record<InternalPage, string> = { home: "New Tab", settings: "Settings", about: "About" };

export function placeToString(place: Place): string {
	return place.kind === "page" ? `deblocker://${place.page}` : place.url;
}

function samePlace(a: Place | undefined, b: Place): boolean {
	if (!a || a.kind !== b.kind) return false;
	return a.kind === "page" ? a.page === (b as { page: InternalPage }).page : a.url === (b as { url: string }).url;
}

interface Tab {
	id: number;
	place: Place;
	history: Place[];
	index: number;
	title: string;
	favicon: string | null;
	loading: boolean;
	/** The frame has finished loading at least one page since the tab started showing web content. */
	committed: boolean;
	/** Set by go(): the next URL change is the result of that navigation (possibly redirected) and replaces the entry. */
	expectingCommit: boolean;
	error: NavigationError | null;
	notice: { title: string; text: string } | null;
	frame: ProxyFrame | null;
	/** Tab strip elements, built once so clicks and keyboard focus survive updates. */
	element: HTMLElement;
	mainEl: HTMLButtonElement;
	faviconEl: HTMLElement;
	titleEl: HTMLElement;
	closeEl: HTMLButtonElement;
	slowTimer: number | undefined;
	slow: boolean;
	/** Restored background tabs load only when first selected. */
	deferred: boolean;
	/** Incremented on every navigation, so late results for an earlier one are ignored. */
	attempt: number;
}

export interface BrowserDeps {
	engine: ProxyEngine;
	searchTemplate(): string;
	hints(): DestinationHints;
	/** Renders an internal page into the stage. */
	showPage(page: InternalPage): void;
	isLocked(): boolean;
	/**
	 * Refines a load failure: the transport reports destinations refused by the server's policy, and
	 * destinations that can't be reached, much like a dead backend. Returns the corrected error.
	 */
	diagnose(error: NavigationError): Promise<NavigationError>;
	sessionChanged(session: SavedSession): void;
	activeChanged(place: Place | null): void;
}

export class Browser {
	private tabs: Tab[] = [];
	private active: Tab | null = null;
	private nextId = 1;
	private omniboxDirty = false;
	/** While the access key is needed: the tab to reopen after unlocking, and a New Tab opened just for the unlock form. */
	private resumeTarget: Tab | null = null;
	private lockPlaceholder: Tab | null = null;

	private readonly tabsEl = $("tabs");
	private readonly newTabButton = $("newTab");
	/** "<tab id>:<page>" of the internal page currently on screen, so it is only rendered when it appears. */
	private shownPage: string | null = null;
	private readonly framesEl = $("frames");
	private readonly omnibox = $<HTMLFormElement>("omnibox");
	private readonly omniboxInput = $<HTMLInputElement>("omniboxInput");
	private readonly omniboxIcon = $("omniboxIcon");
	private readonly backBtn = $<HTMLButtonElement>("backBtn");
	private readonly forwardBtn = $<HTMLButtonElement>("forwardBtn");
	private readonly reloadBtn = $<HTMLButtonElement>("reloadBtn");
	private readonly fullscreenBtn = $<HTMLButtonElement>("fullscreenBtn");
	private readonly progress = $("progress");
	private readonly loader = $("loader");
	private readonly loaderText = $("loaderText");
	private readonly loaderSlow = $("loaderSlow");
	private readonly pageError = $("pageError");

	constructor(private readonly deps: BrowserDeps) {
		this.newTabButton.addEventListener("click", () => this.newTab());
		this.backBtn.addEventListener("click", () => this.back());
		this.forwardBtn.addEventListener("click", () => this.forward());
		this.reloadBtn.addEventListener("click", () => (this.active?.loading ? this.stop() : this.reload()));
		$("homeBtn").addEventListener("click", () => this.home());
		$("loaderStop").addEventListener("click", () => this.stop());
		// Most mouse wheels only scroll vertically; let them scroll an overflowing tab strip sideways.
		this.tabsEl.addEventListener(
			"wheel",
			(event) => {
				if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || this.tabsEl.scrollWidth <= this.tabsEl.clientWidth) return;
				event.preventDefault();
				this.tabsEl.scrollLeft += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 32 : event.deltaY;
			},
			{ passive: false },
		);
		this.fullscreenBtn.addEventListener("click", () => {
			this.active?.frame?.iframe.requestFullscreen().catch(() => toast({ title: "Full screen isn't available here", tone: "error", timeout: 4000 }));
		});

		this.omnibox.addEventListener("submit", (event) => {
			event.preventDefault();
			const error = this.submit(this.omniboxInput.value);
			if (error) {
				toast({ title: "Can't open that", message: error, tone: "error", timeout: 5000, key: "omnibox" });
				return;
			}
			this.omniboxDirty = false;
			this.omniboxInput.blur();
		});
		this.omniboxInput.addEventListener("focus", () => this.omniboxInput.select());
		this.omniboxInput.addEventListener("input", () => (this.omniboxDirty = true));
		this.omniboxInput.addEventListener("blur", () => {
			this.omniboxDirty = false;
			this.renderToolbar();
		});
		this.omniboxInput.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				this.omniboxDirty = false;
				this.renderToolbar();
				this.omniboxInput.blur();
				this.active?.frame?.iframe.focus();
			}
		});
	}

	get activePlace(): Place | null {
		return this.active?.place ?? null;
	}

	get canGoBack(): boolean {
		return Boolean(this.active && this.active.index > 0);
	}

	get tabCount(): number {
		return this.tabs.length;
	}

	focusOmnibox() {
		this.omniboxInput.focus();
		this.omniboxInput.select();
	}

	// ---------------------------------------------------------------- tabs

	newTab(place: Place = { kind: "page", page: "home" }, activate = true, deferred = false): Tab | null {
		if (this.tabs.length >= MAX_TABS) {
			toast({ title: "Too many tabs", message: `Deblocker keeps up to ${MAX_TABS} tabs open. Close one to open another.`, tone: "error", timeout: 5000 });
			return null;
		}
		const mainEl = h("button", { class: "tab-main", type: "button" });
		const faviconEl = h("span", { class: "tab-favicon" });
		const titleEl = h("span", { class: "tab-title" });
		const closeEl = h("button", { class: "tab-close", type: "button", title: "Close tab (Alt+W)" }, icon("x"));
		mainEl.append(faviconEl, titleEl);
		const tab: Tab = {
			id: this.nextId++,
			place,
			history: [place],
			index: 0,
			title: "",
			favicon: null,
			loading: false,
			committed: false,
			expectingCommit: false,
			error: null,
			notice: null,
			frame: null,
			element: h("div", { class: "tab" }, mainEl, closeEl),
			mainEl,
			faviconEl,
			titleEl,
			closeEl,
			slowTimer: undefined,
			slow: false,
			deferred: deferred && !activate && place.kind === "web",
			attempt: 0,
		};
		mainEl.addEventListener("click", () => this.select(tab));
		mainEl.addEventListener("auxclick", (event) => {
			if (event.button === 1) this.closeTab(tab);
		});
		closeEl.addEventListener("click", () => this.closeTab(tab));
		this.tabs.push(tab);
		this.tabsEl.append(tab.element);
		if (activate) this.select(tab);
		if (!tab.deferred) this.display(tab, place);
		this.renderTab(tab);
		tab.element.scrollIntoView({ block: "nearest", inline: "nearest" });
		this.persist();
		return tab;
	}

	closeTab(tab: Tab) {
		const index = this.tabs.indexOf(tab);
		if (index === -1) return;
		const hadFocus = tab.element.contains(document.activeElement);
		this.tabs.splice(index, 1);
		window.clearTimeout(tab.slowTimer);
		tab.frame?.destroy();
		tab.frame = null;
		tab.element.classList.add("closing");
		window.setTimeout(() => tab.element.remove(), 160);
		if (this.tabs.length === 0) {
			this.active = null;
			this.newTab();
			return;
		}
		if (this.active === tab) this.select(this.tabs[Math.min(index, this.tabs.length - 1)]!);
		if (hadFocus) this.active?.mainEl.focus();
		this.persist();
	}

	closeActive() {
		if (this.active) this.closeTab(this.active);
	}

	selectIndex(index: number) {
		const tab = this.tabs[index];
		if (tab) this.select(tab);
	}

	cycle(delta: number) {
		if (!this.active || this.tabs.length < 2) return;
		const index = (this.tabs.indexOf(this.active) + delta + this.tabs.length) % this.tabs.length;
		this.select(this.tabs[index]!);
	}

	select(tab: Tab) {
		const previous = this.active;
		this.active = tab;
		if (tab.deferred) {
			tab.deferred = false;
			this.display(tab, tab.place);
		}
		if (previous && previous !== tab) this.renderTab(previous);
		this.renderTab(tab);
		this.omniboxDirty = false;
		this.renderStage();
		this.persist();
	}

	closeAll() {
		for (const tab of [...this.tabs]) {
			window.clearTimeout(tab.slowTimer);
			tab.frame?.destroy();
			tab.element.remove();
		}
		this.tabs = [];
		this.active = null;
	}

	restore(session: SavedSession | null, initialUrl: string | null) {
		const locked = this.deps.isLocked();
		if (session) {
			for (const saved of session.tabs) {
				const resolved = resolveInput(saved.url, this.deps.searchTemplate());
				const place: Place | null =
					resolved.kind === "internal" ? { kind: "page", page: resolved.page } : resolved.kind === "url" ? { kind: "web", url: resolved.url } : null;
				if (place) this.newTab(place, false, true);
			}
			const target = this.tabs[session.active] ?? this.tabs[0];
			// While locked, web tabs stay unloaded and the home page (with the unlock form) is shown.
			if (target && (!locked || target.place.kind === "page")) this.select(target);
			else if (locked) {
				this.resumeTarget = target ?? null;
				let home: Tab | null | undefined = this.tabs.find((tab) => tab.place.kind === "page" && tab.place.page === "home");
				if (!home) home = this.lockPlaceholder = this.newTab(undefined, false);
				if (home) this.select(home);
			}
		}
		if (this.tabs.length === 0) this.newTab();
		if (initialUrl) {
			const error = this.submit(initialUrl, { newTab: this.active?.place.kind === "web" });
			if (error) toast({ title: "Can't open that link", message: error, tone: "error" });
		}
	}

	/** After the access key was entered: return to the page the visitor was on and reload pages that failed meanwhile. */
	resume() {
		for (const tab of this.tabs) {
			if (tab.place.kind === "web" && tab.error?.kind === "locked") tab.deferred = true;
		}
		const target = this.resumeTarget;
		const placeholder = this.lockPlaceholder;
		this.resumeTarget = this.lockPlaceholder = null;
		if (target && this.tabs.includes(target)) {
			const sentHome = target === this.active && target.place.kind === "page" && target.place.page === "home";
			if (sentHome && this.canGoBack) this.back();
			else if (target !== this.active) this.select(target);
		}
		if (placeholder && placeholder !== this.active && placeholder.history.length === 1) this.closeTab(placeholder);
		const tab = this.active;
		if (tab?.deferred && tab.place.kind === "web") {
			tab.deferred = false;
			this.display(tab, tab.place, true);
		}
	}

	/** The session ended (access key required again): stop loading pages and show the unlock form. */
	lock() {
		for (const tab of this.tabs) tab.frame?.stop();
		const tab = this.active;
		if (tab?.place.kind === "web") this.resumeTarget = tab;
		this.home();
	}

	// ---------------------------------------------------------------- navigation

	/** Opens whatever the visitor typed. Returns an error message for input that can't be opened. */
	submit(input: string, options: { newTab?: boolean } = {}): string | null {
		if (this.deps.isLocked()) return "Enter this server's access key first.";
		const resolved = resolveInput(input, this.deps.searchTemplate());
		if (resolved.kind === "error") return resolved.message;
		const place: Place = resolved.kind === "internal" ? { kind: "page", page: resolved.page } : { kind: "web", url: resolved.url };
		this.open(place, options);
		return null;
	}

	open(place: Place, options: { newTab?: boolean } = {}) {
		if (options.newTab || !this.active) {
			this.newTab(place);
			return;
		}
		this.navigate(this.active, place);
	}

	/** Shows an internal page, reusing a tab that already shows it or a blank home tab when possible. */
	openPage(page: InternalPage) {
		if (page === "home") {
			this.home();
			return;
		}
		const existing = this.tabs.find((tab) => tab.place.kind === "page" && tab.place.page === page);
		if (existing) {
			this.select(existing);
			return;
		}
		if (this.active && this.active.place.kind === "page" && this.active.place.page === "home") this.navigate(this.active, { kind: "page", page });
		else this.newTab({ kind: "page", page });
	}

	navigate(tab: Tab, place: Place) {
		if (samePlace(tab.history[tab.index], place)) {
			// Opening the address that is already showing reloads it, as in any browser.
			this.display(tab, place, place.kind === "web");
			return;
		}
		tab.history = tab.history.slice(0, tab.index + 1);
		tab.history.push(place);
		tab.index = tab.history.length - 1;
		this.display(tab, place);
	}

	back() {
		const tab = this.active;
		if (!tab || tab.index === 0) return;
		tab.index -= 1;
		this.display(tab, tab.history[tab.index]!);
	}

	forward() {
		const tab = this.active;
		if (!tab || tab.index >= tab.history.length - 1) return;
		tab.index += 1;
		this.display(tab, tab.history[tab.index]!);
	}

	home() {
		if (this.active) this.navigate(this.active, { kind: "page", page: "home" });
	}

	reload() {
		const tab = this.active;
		if (!tab) return;
		this.reloadBtn.classList.remove("spin-once");
		void this.reloadBtn.offsetWidth;
		this.reloadBtn.classList.add("spin-once");
		if (tab.place.kind === "page") {
			this.display(tab, tab.place);
			return;
		}
		if (tab.error || tab.notice || !tab.frame || !tab.committed) {
			this.display(tab, tab.place, true);
			return;
		}
		tab.error = null;
		tab.frame.reload();
		this.renderStage();
	}

	stop() {
		const tab = this.active;
		if (!tab?.frame || !tab.loading) return;
		tab.frame.stop();
		tab.expectingCommit = false;
		this.finishLoading(tab);
	}

	/** Makes the tab show `place`, loading it in the frame if needed. */
	private display(tab: Tab, place: Place, forceLoad = false) {
		tab.attempt += 1;
		tab.place = place;
		tab.error = null;
		tab.notice = null;
		window.clearTimeout(tab.slowTimer);
		tab.slow = false;

		if (place.kind === "page") {
			// Leaving for an internal page cancels a navigation still in flight, so it can't land later
			// and overwrite the history entry. The page's title and icon are kept for coming back.
			if (tab.loading || tab.expectingCommit) tab.frame?.stop();
			tab.loading = false;
			tab.expectingCommit = false;
		} else {
			const blocked = explainBlockedDestination(place.url, this.deps.hints());
			if (blocked) {
				tab.loading = false;
				tab.title = hostLabel(place.url);
				tab.notice = { title: "Blocked by this server", text: blocked };
			} else if (this.deps.engine.status === "failed") {
				tab.loading = false;
				tab.title = hostLabel(place.url);
				tab.error = { kind: "transport", url: place.url, detail: this.deps.engine.failure ?? "The proxy engine could not start." };
			} else if (forceLoad || !tab.frame || tab.expectingCommit || tab.frame.showingError || tab.frame.currentUrl !== place.url) {
				// Reload unless the frame already shows exactly this page (an unfinished navigation or a
				// failed load doesn't count).
				this.load(tab, place.url);
			}
		}
		this.renderTab(tab);
		if (tab === this.active) this.renderStage();
		this.persist();
	}

	private load(tab: Tab, url: string) {
		tab.title = hostLabel(url);
		tab.favicon = null;
		tab.expectingCommit = true;
		this.startLoading(tab);
		if (!tab.frame) {
			tab.committed = false;
			tab.frame = this.deps.engine.createFrame(this.framesEl, this.frameEvents(tab));
		}
		const frame = tab.frame;
		this.deps.engine
			.ready()
			.then(() => {
				if (tab.frame === frame && tab.place.kind === "web" && tab.place.url === url) frame.go(url);
			})
			.catch((error: unknown) => {
				if (tab.frame !== frame) return;
				this.fail(tab, { kind: "transport", url, detail: error instanceof Error ? error.message : String(error) });
			});
	}

	private frameEvents(tab: Tab) {
		return {
			urlChanged: (url: string, kind: NavigationKind) => this.onUrlChanged(tab, url, kind),
			titleChanged: (title: string) => {
				if (tab.place.kind !== "web") return;
				const next = title.trim() || hostLabel(tab.place.url);
				if (next === tab.title) return;
				tab.title = next;
				this.renderTab(tab);
			},
			faviconChanged: (href: string | null) => {
				if (href === tab.favicon) return;
				tab.favicon = href;
				this.renderTab(tab);
			},
			loadStarted: () => {
				if (tab.place.kind === "web" && !tab.loading) this.startLoading(tab);
			},
			loadFinished: () => {
				tab.committed = true;
				this.finishLoading(tab);
			},
			failed: (error: NavigationError) => this.fail(tab, error),
		};
	}

	private onUrlChanged(tab: Tab, url: string, kind: NavigationKind) {
		// The frame keeps running while the tab shows an internal page; its history stays as it was.
		if (tab.place.kind === "page") return;
		tab.attempt += 1;
		const place: Place = { kind: "web", url };
		if (tab.expectingCommit) {
			// First URL after Deblocker navigated the frame: it replaces the entry, so redirects
			// (example.com -> www.example.com) don't add history.
			tab.expectingCommit = false;
			tab.history[tab.index] = place;
		} else if (kind === "replace") {
			tab.history[tab.index] = place;
		} else if (kind === "traverse") {
			// The browser's own back/forward (or history.back() in the page) moved through this frame's
			// history; find the entry it arrived at, nearest first.
			const target = [tab.index - 1, tab.index + 1, ...tab.history.keys()].find((i) => samePlace(tab.history[i], place));
			if (target !== undefined) tab.index = target;
			else tab.history[tab.index] = place;
		} else if (!samePlace(tab.history[tab.index], place)) {
			tab.history = tab.history.slice(0, tab.index + 1);
			tab.history.push(place);
			tab.index = tab.history.length - 1;
		}
		tab.place = place;
		tab.error = null;
		// The title is left alone: new documents report theirs as soon as they parse it.
		this.renderTab(tab);
		if (tab === this.active) this.renderToolbar();
		this.persist();
	}

	private startLoading(tab: Tab) {
		tab.loading = true;
		window.clearTimeout(tab.slowTimer);
		tab.slow = false;
		tab.slowTimer = window.setTimeout(() => {
			tab.slow = true;
			if (tab === this.active) this.renderStage();
		}, SLOW_LOAD_MS);
		this.renderTab(tab);
		if (tab === this.active) this.renderStage();
	}

	private finishLoading(tab: Tab) {
		tab.loading = false;
		tab.slow = false;
		window.clearTimeout(tab.slowTimer);
		this.renderTab(tab);
		if (tab === this.active) this.renderStage();
	}

	/** Shows a load failure once it has been diagnosed (bounded, so a slow check never hides the error). */
	private fail(tab: Tab, error: NavigationError) {
		tab.expectingCommit = false;
		const attempt = ++tab.attempt;
		const fallback = new Promise<NavigationError>((resolve) => window.setTimeout(() => resolve(error), 2500));
		Promise.race([this.deps.diagnose(error).catch(() => error), fallback]).then((final) => {
			if (tab.attempt !== attempt) return; // the tab navigated somewhere else meanwhile
			tab.error = final;
			this.finishLoading(tab);
		});
	}

	// ---------------------------------------------------------------- rendering

	private tabTitle(tab: Tab): string {
		if (tab.place.kind === "page") return PAGE_TITLES[tab.place.page];
		return tab.title || hostLabel(tab.place.url);
	}

	private renderTab(tab: Tab) {
		const selected = tab === this.active;
		const title = this.tabTitle(tab);
		let favicon: Node;
		if (tab.loading) favicon = h("span", { class: "spinner-sm" });
		else if (tab.place.kind === "page") favicon = icon("brand");
		else if (tab.error || tab.notice) favicon = icon("alert");
		else if (tab.favicon) {
			const img = h("img", { src: tab.favicon, alt: "", referrerpolicy: "no-referrer" });
			img.addEventListener("error", () => img.replaceWith(icon("globe")), { once: true });
			favicon = img;
		} else favicon = icon("globe");

		tab.element.classList.toggle("is-active", selected);
		if (selected) tab.mainEl.setAttribute("aria-current", "page");
		else tab.mainEl.removeAttribute("aria-current");
		tab.mainEl.title = tab.place.kind === "web" ? `${title}\n${tab.place.url}` : title;
		tab.closeEl.setAttribute("aria-label", `Close ${title}`);
		const iconKey = `${tab.loading}|${tab.place.kind}|${Boolean(tab.error || tab.notice)}|${tab.favicon ?? ""}`;
		if (tab.faviconEl.dataset.key !== iconKey) {
			tab.faviconEl.dataset.key = iconKey;
			tab.faviconEl.replaceChildren(favicon);
		}
		if (tab.titleEl.textContent !== title) tab.titleEl.textContent = title;
		if (selected) document.title = tab.place.kind === "page" && tab.place.page === "home" ? "Deblocker" : `${title} · Deblocker`;
	}

	private renderStage() {
		const tab = this.active;
		for (const other of this.tabs) {
			other.frame?.iframe.classList.toggle("is-active", other === tab && tab.place.kind === "web" && !tab.notice && !tab.error);
		}

		const page = tab?.place.kind === "page" ? tab.place.page : null;
		for (const name of ["home", "settings", "about"] as const) $(`view-${name}`).hidden = page !== name;
		const pageKey = page && tab ? `${tab.id}:${page}` : null;
		if (pageKey !== this.shownPage) {
			this.shownPage = pageKey;
			if (page) this.deps.showPage(page);
		}

		const showLoader = Boolean(tab && tab.place.kind === "web" && tab.loading && !tab.committed && !tab.error);
		this.loader.hidden = !showLoader;
		if (showLoader && tab?.place.kind === "web") {
			this.loaderText.textContent = `loading ${hostLabel(tab.place.url)}…`;
			this.loaderSlow.hidden = !tab.slow;
		}
		this.progress.classList.toggle("is-active", Boolean(tab?.loading));
		this.renderError(tab);
		this.renderToolbar();
		this.deps.activeChanged(tab?.place ?? null);
	}

	private renderError(tab: Tab | null) {
		if (!tab || tab.place.kind !== "web" || (!tab.error && !tab.notice)) {
			this.pageError.hidden = true;
			return;
		}
		const url = tab.place.url;
		const host = hostLabel(url);
		const actions: HTMLElement[] = [];
		const button = (label: string, iconName: string, run: () => void, accent = false) =>
			h("button", { class: accent ? "btn btn-accent" : "btn", type: "button", onclick: run }, icon(iconName), label);

		let title: string;
		let text: string;
		let tone = "error";
		if (tab.notice) {
			({ title, text } = tab.notice);
			tone = "info";
		} else {
			const error = tab.error!;
			switch (error.kind) {
				case "blocked":
					title = "Blocked by this server";
					text = `This Deblocker server's policy doesn't allow connections to ${host}.`;
					tone = "info";
					break;
				case "dns":
					title = "This site can't be found";
					text = `The server couldn't find ${host}. Check the address for typos, or search for it instead.`;
					break;
				case "refused":
					title = "This site can't be reached";
					text = `${host} refused the connection.`;
					break;
				case "unreachable":
					title = "This site can't be reached";
					text = `The Deblocker server couldn't get a response from ${host}. Check the address for typos; the site may also be down or not exist.`;
					break;
				case "timeout":
					title = "This site took too long to respond";
					text = `${host} didn't respond in time. It may be down or overloaded.`;
					break;
				case "tls":
					title = "Secure connection failed";
					text = `A secure connection to ${host} couldn't be established.`;
					break;
				case "locked":
					title = "Access key needed";
					text = "Your session with this Deblocker server has ended. Enter the access key on the home page to continue.";
					tone = "info";
					break;
				case "transport":
					title = "Can't reach the Deblocker server";
					text = "The proxy backend isn't responding. The server may be down, or a network may be blocking its WebSocket connection.";
					break;
				default:
					title = "This page couldn't be loaded";
					text = `Something went wrong while loading ${host}.`;
			}
		}
		const detail = tab.error && tab.error.kind !== "blocked" && tab.error.kind !== "locked" ? tab.error.detail : "";

		if (tab.error?.kind === "locked") actions.push(button("enter access key", "key", () => this.lock(), true));
		else if (!tab.notice && tab.error?.kind !== "blocked") actions.push(button("try again", "rotate-cw", () => this.reload(), true));
		if (tab.error?.kind === "dns" || tab.error?.kind === "unreachable") {
			actions.push(
				button("search instead", "search", () => {
					const query = host.replace(/^www\./, "");
					this.navigate(tab, { kind: "web", url: this.deps.searchTemplate().replace("%s", encodeURIComponent(query)) });
				}),
			);
		}
		if (tab.error && (tab.error.kind === "refused" || tab.error.kind === "tls" || tab.error.kind === "unreachable") && url.startsWith("https://")) {
			actions.push(button("try http://", "lock-open", () => this.navigate(tab, { kind: "web", url: `http://${url.slice("https://".length)}` })));
		}
		if (tab.index > 0) actions.push(button("go back", "arrow-left", () => this.back()));
		actions.push(button("home", "house", () => this.home()));

		this.pageError.dataset.tone = tone;
		$("pageErrorTitle").textContent = title;
		$("pageErrorText").textContent = text;
		$("pageErrorDetail").textContent = detail ? `Details: ${detail}` : "";
		$("pageErrorDetail").hidden = !detail;
		$("pageErrorUrl").textContent = url;
		$("pageErrorActions").replaceChildren(...actions);
		this.pageError.hidden = false;
	}

	renderToolbar() {
		const tab = this.active;
		this.backBtn.disabled = !tab || tab.index === 0;
		this.forwardBtn.disabled = !tab || tab.index >= tab.history.length - 1;
		this.reloadBtn.classList.toggle("is-loading", Boolean(tab?.loading));
		this.reloadBtn.title = tab?.loading ? "Stop loading" : "Reload (Alt+R)";
		this.reloadBtn.setAttribute("aria-label", tab?.loading ? "Stop loading" : "Reload");
		this.fullscreenBtn.disabled = !(tab?.place.kind === "web" && tab.committed && !tab.error && !tab.notice);

		let kind = "search";
		let iconName = "search";
		let value = "";
		if (tab?.place.kind === "page") {
			if (tab.place.page !== "home") {
				kind = "internal";
				iconName = "brand";
				value = placeToString(tab.place);
			}
		} else if (tab?.place.kind === "web") {
			value = tab.place.url;
			if (tab.error || tab.notice) {
				kind = "error";
				iconName = "alert";
			} else if (tab.place.url.startsWith("https://")) {
				kind = "secure";
				iconName = "lock";
			} else {
				kind = "insecure";
				iconName = "lock-open";
			}
		}
		this.omniboxIcon.dataset.kind = kind;
		this.omniboxIcon.title =
			kind === "secure"
				? "Encrypted (HTTPS) connection to this site. This doesn't mean the site is trustworthy."
				: kind === "insecure"
					? "Not encrypted: this site uses plain HTTP"
					: "";
		$("omniboxIconSvg").querySelector("use")!.setAttribute("href", `#i-${iconName}`);
		if (!this.omniboxDirty && document.activeElement !== this.omniboxInput) this.omniboxInput.value = value;
	}

	private persist() {
		this.deps.sessionChanged({
			tabs: this.tabs.map((tab) => ({ url: placeToString(tab.place) })),
			active: this.active ? Math.max(0, this.tabs.indexOf(this.active)) : 0,
		});
	}
}
