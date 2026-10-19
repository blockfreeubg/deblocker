/*
 * Scramjet integration (Scramjet 2.x + Scramjet Controller), following the architecture of the
 * official create-proxy-app template and proxy-bootstrap client:
 *
 *   1. register the service worker (sw.js) at the app's base path,
 *   2. load scramjet.js, controller.api.js, scramjet-utils.js and the transport bundle,
 *   3. create a transport pointed at <base>wisp/ and a Controller configured with base-relative paths,
 *   4. create one Controller Frame per Deblocker tab and navigate it with frame.go(url).
 *
 * Every path is derived from the base path, so Deblocker works at "/" or under any sub-path.
 */
import type { TransportName } from "../../../shared/public-config.js";
import type { EngineStatus, FrameEvents, NavigationError, NavigationErrorKind, ProxyEngine, ProxyFrame } from "./types.js";

/* Minimal shapes of the runtime globals defined by the engine bundles. */
interface ScramjetFrame {
	prefix: string;
	element: HTMLIFrameElement;
	context: unknown;
	hooks: {
		init: { post: unknown };
		error: { request: unknown };
	};
	go(url: string): void;
	reload(): void;
}

interface ScramjetController {
	prefix: string;
	frames: ScramjetFrame[];
	cookieJar: { clear(): void };
	wait(): Promise<void>;
	createFrame(element: HTMLIFrameElement, options?: { plugins: unknown[] }): ScramjetFrame;
	persistCookies(): Promise<void>;
}

interface TapPlugin {
	tap(hook: unknown, handler: (context: any, props: any) => unknown, options?: unknown): void;
}

declare global {
	interface Window {
		$scramjet?: {
			Plugin: new (name: string) => TapPlugin;
			unrewriteUrl(url: string, context: unknown): string;
		};
		$scramjetController?: {
			Controller: new (init: Record<string, unknown>) => ScramjetController;
		};
		$scramjetUtils?: {
			HttpCachePlugin: new (options?: Record<string, unknown>) => unknown;
			CACHE_NAME: string;
		};
		LibcurlTransport?: Record<string, new (options: { wisp: string }) => unknown>;
		EpoxyTransport?: Record<string, new (options: { wisp: string }) => unknown>;
	}
}

export interface EngineOptions {
	base: string;
	transport: TransportName;
}

const START_TIMEOUT_MS = 25_000;
const ERROR_MARKER = "deblocker-error";

function loadScript(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const existing = document.querySelector<HTMLScriptElement>(`script[data-engine="${src}"]`);
		if (existing) {
			existing.dataset.loaded ? resolve() : existing.addEventListener("load", () => resolve(), { once: true });
			return;
		}
		const script = document.createElement("script");
		script.src = src;
		script.dataset.engine = src;
		script.addEventListener("load", () => {
			script.dataset.loaded = "1";
			resolve();
		});
		script.addEventListener("error", () => reject(new Error(`Couldn't load ${src}. Check that the server is running and up to date.`)));
		document.head.append(script);
	});
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function registerServiceWorker(base: string): Promise<ServiceWorker> {
	const registration = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base, updateViaCache: "none" });
	// Pick up a new sw.js after a Deblocker upgrade without requiring a second reload.
	registration.update().catch(() => {});
	if (registration.active) return registration.active;
	const ready = await navigator.serviceWorker.ready;
	if (!ready.active) throw new Error("The service worker didn't activate.");
	return ready.active;
}

/**
 * Maps transport / Wisp / Scramjet error text onto something we can explain to people.
 * libcurl reports curl error codes; epoxy reports hyper/rustls errors.
 */
export function classifyError(error: unknown): { kind: NavigationErrorKind; detail: string } {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
	const detail = text.replace(/^(Type)?Error:\s*/, "").slice(0, 240);
	const test = (pattern: RegExp) => pattern.test(text);
	// The Wisp backend itself is unreachable (libcurl code 7, epoxy WebSocketConnectFailed).
	if (test(/error code 7\b|could not connect to server|WebSocketConnectFailed|websocket did not open/i)) return { kind: "transport", detail };
	if (test(/\b(HostBlocked|0x48|non-public address)\b/i)) return { kind: "blocked", detail };
	if (test(/error code 6\b|resolve host|could not resolve|couldn't resolve|ENOTFOUND|EAI_AGAIN|getaddrinfo/i)) return { kind: "dns", detail };
	if (test(/refused|ECONNREFUSED|0x44/i)) return { kind: "refused", detail };
	if (test(/error code 28\b|timed? ?out|timeout|ETIMEDOUT|0x47|0x43/i)) return { kind: "timeout", detail };
	if (test(/error code 35\b|error code 60\b|ssl|tls|certificate|handshake|x509|InvalidContentType/i)) return { kind: "tls", detail };
	// libcurl code 52 ("Server returned nothing") covers refused connections, unknown hosts and refused destinations alike.
	if (test(/error code 52\b|error code 56\b|server returned nothing|IncompleteMessage|unreachable|EHOSTUNREACH|ENETUNREACH|0x42/i)) {
		return { kind: "unreachable", detail };
	}
	if (test(/websocket|wisp|connection (was )?closed|network ?error/i)) return { kind: "transport", detail };
	return { kind: "unknown", detail };
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Body returned instead of a failed document. Inside nested iframes it shows a small notice; for the
 * top-level page the Deblocker UI detects the marker and shows its own error card over it.
 */
function errorDocument(url: string, kind: NavigationErrorKind, detail: string): string {
	return `<!doctype html><html data-${ERROR_MARKER}="${escapeHtml(kind)}" data-url="${escapeHtml(url)}" data-detail="${escapeHtml(detail)}"><head><meta charset="utf-8"><title>Couldn't load page</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d11;color:#a9afbd;font:13px/1.5 system-ui,sans-serif}p{max-width:30em;padding:16px;text-align:center}</style></head>
<body><p>This content couldn't be loaded through Deblocker (${escapeHtml(kind)}).</p></body></html>`;
}

function decodeFrameUrl(frame: ScramjetFrame, href: string): string | null {
	try {
		const url = new URL(href);
		if (url.origin !== location.origin || !url.pathname.startsWith(frame.prefix)) return null;
		return window.$scramjet!.unrewriteUrl(href, frame.context);
	} catch {
		return null;
	}
}

class ScramjetProxyFrame implements ProxyFrame {
	readonly iframe: HTMLIFrameElement;
	private frame: ScramjetFrame | null = null;
	private lastUrl: string | null = null;
	private titleObserver: MutationObserver | null = null;
	private destroyed = false;

	constructor(
		private readonly engine: ScramjetEngine,
		container: HTMLElement,
		private readonly events: FrameEvents,
	) {
		this.iframe = document.createElement("iframe");
		this.iframe.title = "Proxied page";
		this.iframe.setAttribute("allow", "fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture");
		this.iframe.addEventListener("load", () => this.onLoad());
		container.append(this.iframe);
	}

	get currentUrl(): string | null {
		if (this.frame) {
			try {
				const decoded = decodeFrameUrl(this.frame, this.iframe.contentWindow?.location.href ?? "");
				if (decoded) return decoded;
			} catch {
				// cross-origin or detached; fall back to the last URL we saw
			}
		}
		return this.lastUrl;
	}

	go(url: string): void {
		if (this.destroyed) return;
		// Forget the previous URL so the next commit is always reported, even if a redirect
		// lands on the page that was already showing.
		this.lastUrl = null;
		this.ensureFrame().go(url);
	}

	reload(): void {
		if (!this.frame) return;
		this.events.loadStarted();
		try {
			this.iframe.contentWindow?.location.reload();
		} catch {
			if (this.lastUrl) this.frame.go(this.lastUrl);
		}
	}

	stop(): void {
		try {
			this.iframe.contentWindow?.stop();
		} catch {
			// ignore
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.titleObserver?.disconnect();
		this.iframe.src = "about:blank";
		this.iframe.remove();
		if (this.frame) this.engine.forgetFrame(this.frame);
		this.frame = null;
	}

	private ensureFrame(): ScramjetFrame {
		if (this.frame) return this.frame;
		this.frame = this.engine.attach(this.iframe, {
			urlChanged: (url) => this.setUrl(url),
			documentReady: (win) => this.watchDocument(win),
		});
		return this.frame;
	}

	private setUrl(url: string) {
		if (url === this.lastUrl) return;
		this.lastUrl = url;
		this.events.urlChanged(url);
	}

	/** Called by the engine for every new top-level document Scramjet initialises in this frame. */
	private watchDocument(win: Window) {
		this.titleObserver?.disconnect();
		const readTitle = () => {
			try {
				this.events.titleChanged(win.document.title ?? "");
			} catch {
				// document went away
			}
		};
		const observe = () => {
			readTitle();
			this.titleObserver?.disconnect();
			if (!win.document.head) return;
			this.titleObserver = new MutationObserver(readTitle);
			this.titleObserver.observe(win.document.head, { subtree: true, childList: true, characterData: true });
		};
		if (win.document.readyState === "loading") win.document.addEventListener("DOMContentLoaded", observe, { once: true });
		else observe();
		win.addEventListener("beforeunload", () => this.events.loadStarted());
		// Forward Deblocker's keyboard shortcuts while the page has focus.
		win.addEventListener(
			"keydown",
			(event) => {
				const handler = (window as unknown as { __deblockerShortcuts?: (event: KeyboardEvent) => void }).__deblockerShortcuts;
				if (handler && (event.altKey || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") || event.key === "F6")) handler(event);
			},
			true,
		);
	}

	private onLoad() {
		if (this.destroyed || !this.frame) return;
		let doc: Document | null = null;
		try {
			doc = this.iframe.contentDocument;
		} catch {
			doc = null;
		}
		const marker = doc?.documentElement?.getAttribute(`data-${ERROR_MARKER}`);
		if (doc && marker) {
			const url = doc.documentElement.getAttribute("data-url") ?? this.lastUrl ?? "";
			const error: NavigationError = {
				kind: marker as NavigationErrorKind,
				url,
				detail: doc.documentElement.getAttribute("data-detail") ?? "",
			};
			if (url) this.setUrl(url);
			this.events.failed(error);
			return;
		}
		const decoded = this.currentUrl;
		if (decoded) this.setUrl(decoded);
		if (doc) {
			this.events.titleChanged(doc.title ?? "");
			this.events.faviconChanged(this.faviconFor(doc));
		}
		this.events.loadFinished();
	}

	/** Proxied URL of the page's icon (or /favicon.ico), so the tab can show it. */
	private faviconFor(doc: Document): string | null {
		if (!this.frame || !this.lastUrl) return null;
		try {
			const link = doc.querySelector<HTMLLinkElement>('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
			const raw = link?.getAttribute("href");
			let href: string;
			if (raw && raw.startsWith(location.origin + this.frame.prefix)) href = raw;
			else if (raw && raw.startsWith(this.frame.prefix)) href = location.origin + raw;
			else {
				const absolute = new URL(raw || "/favicon.ico", this.lastUrl);
				if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return null;
				href = `${location.origin}${this.frame.prefix}${encodeURIComponent(absolute.href)}`;
			}
			return href;
		} catch {
			return null;
		}
	}
}

interface AttachCallbacks {
	urlChanged(url: string): void;
	documentReady(win: Window): void;
}

class ScramjetEngine implements ProxyEngine {
	status: EngineStatus = "starting";
	failure: string | null = null;
	private controller: ScramjetController | null = null;
	private readonly startup: Promise<void>;

	constructor(private readonly options: EngineOptions) {
		this.startup = this.start().then(
			() => {
				this.status = "ready";
			},
			(error: unknown) => {
				this.status = "failed";
				this.failure = error instanceof Error ? error.message : String(error);
				throw error;
			},
		);
		this.startup.catch(() => {});
	}

	get wispUrl(): string {
		return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${this.options.base}wisp/`;
	}

	ready(): Promise<void> {
		return this.startup;
	}

	private async start() {
		if (!window.isSecureContext) {
			throw new Error("Deblocker must be opened over HTTPS (or on localhost) because it relies on a service worker.");
		}
		if (!("serviceWorker" in navigator)) {
			throw new Error("This browser doesn't allow service workers here (private browsing modes often disable them).");
		}
		const base = this.options.base;
		const worker = await withTimeout(registerServiceWorker(base), START_TIMEOUT_MS, "The service worker took too long to start.");

		await loadScript(`${base}engine/scramjet.js`);
		await loadScript(`${base}engine/controller.api.js`);
		await Promise.all([loadScript(`${base}engine/scramjet-utils.js`), loadScript(`${base}engine/transport.js`)]);

		const transport = this.createTransport();
		const api = window.$scramjetController;
		if (!api) throw new Error("Scramjet Controller failed to load.");
		this.controller = new api.Controller({
			serviceworker: worker,
			transport,
			config: {
				// Must be absolute and inside the service worker scope; sw.js derives the same prefix.
				prefix: `${base}~/sj/`,
				scramjetPath: `${base}engine/scramjet.js`,
				injectPath: `${base}engine/controller.inject.js`,
				wasmPath: `${base}engine/scramjet.wasm`,
			},
			scramjetConfig: {
				// The controller means to enable allowFailedIntercepts, but its config merge order drops it.
				flags: { allowFailedIntercepts: true, sourcemaps: false, captureErrors: false, rewriterLogs: false },
			},
		});
		await withTimeout(this.controller.wait(), START_TIMEOUT_MS, "Scramjet took too long to start. Try reloading the page.");

		const controller = this.controller as ScramjetController & Record<string, any>;
		// The controller ignores the service worker's "revive" message for 5 s after start-up. That guard
		// only protects against the worker's own first boot, and would leave Deblocker broken if the worker
		// restarts in that window, so turn it off.
		controller.guardServiceWorkerRevive = false;
		// After a service worker update the controller would keep talking to the old, redundant worker.
		navigator.serviceWorker.addEventListener("controllerchange", () => {
			const active = navigator.serviceWorker.controller;
			if (active && active !== controller.serviceWorkerController) {
				controller.serviceWorkerController = active;
				controller.setupMessagePort?.();
			}
		});
	}

	private createTransport(): unknown {
		const wisp = this.wispUrl;
		if (this.options.transport === "epoxy") {
			const Epoxy = window.EpoxyTransport?.default ?? window.EpoxyTransport?.EpoxyTransport;
			if (!Epoxy) throw new Error("The epoxy transport failed to load.");
			return new Epoxy({ wisp });
		}
		const Libcurl = window.LibcurlTransport?.LibcurlClient ?? window.LibcurlTransport?.default;
		if (!Libcurl) throw new Error("The libcurl transport failed to load.");
		return new Libcurl({ wisp });
	}

	createFrame(container: HTMLElement, events: FrameEvents): ProxyFrame {
		return new ScramjetProxyFrame(this, container, events);
	}

	/** Wraps an iframe in a Scramjet Controller frame and installs Deblocker's hooks. */
	attach(iframe: HTMLIFrameElement, callbacks: AttachCallbacks): ScramjetFrame {
		const controller = this.controller;
		const scramjet = window.$scramjet;
		if (!controller || !scramjet) throw new Error("The proxy engine isn't ready yet.");

		// Plugins are bound to a single frame, so each frame gets its own HTTP cache plugin instance.
		const utils = window.$scramjetUtils;
		const frame = controller.createFrame(iframe, { plugins: utils ? [new utils.HttpCachePlugin()] : [] });
		const plugin = new scramjet.Plugin("deblocker");

		plugin.tap(frame.hooks.init.post, (context: { isTopLevel: boolean; window: Window; client: any }) => {
			try {
				// Published Scramjet 2.0.67-alpha.2 turns history.pushState(state, title) without a URL into
				// ".../undefined" (fixed upstream on main). Fill in the current URL, as browsers do.
				context.client.Proxy(["History.prototype.pushState", "History.prototype.replaceState"], {
					apply(call: { args: unknown[] }) {
						if (call.args[2] === undefined || call.args[2] === null) call.args[2] = context.client.url.href;
					},
				});
				if (!context.isTopLevel) return;
				const current = () => context.client.url.href as string;
				callbacks.urlChanged(current());
				callbacks.documentReady(context.window);
				// "location" events carry a relative or stale URL and are followed by a new document anyway.
				plugin.tap(context.client.hooks.lifecycle.navigate, (navigation: { type?: string }) => {
					if (navigation?.type !== "location") callbacks.urlChanged(current());
				});
				context.window.addEventListener("hashchange", () => callbacks.urlChanged(current()), { capture: true });
				context.window.addEventListener("popstate", () => callbacks.urlChanged(current()), { capture: true });
			} catch (error) {
				console.warn("Deblocker: couldn't attach to a proxied document", error);
			}
		});

		// Failed page loads get an error document; ScramjetProxyFrame shows Deblocker's error card for it.
		plugin.tap(frame.hooks.error.request, (context: { rawrequest: { rawUrl: string; destination: string }; error: unknown }, props: any) => {
			const destination = context.rawrequest.destination;
			if (destination !== "document" && destination !== "iframe") return;
			const { kind, detail } = classifyError(context.error);
			const url = decodeFrameUrl(frame, context.rawrequest.rawUrl) ?? context.rawrequest.rawUrl;
			props.suppressError = true;
			props.setResponse = {
				status: 502,
				statusText: "Bad Gateway",
				headers: [
					["content-type", "text/html; charset=utf-8"],
					["cache-control", "no-store"],
					// Served at the Deblocker origin and built from attacker-influenced text: no scripts, ever.
					["content-security-policy", "default-src 'none'; style-src 'unsafe-inline'"],
				],
				body: errorDocument(url, kind, detail),
			};
		});

		return frame;
	}

	forgetFrame(frame: ScramjetFrame) {
		if (!this.controller) return;
		const index = this.controller.frames.indexOf(frame);
		if (index !== -1) this.controller.frames.splice(index, 1);
	}

	checkBackend(): Promise<boolean> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (ok: boolean) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				try {
					socket.close();
				} catch {
					// ignore
				}
				resolve(ok);
			};
			let socket: WebSocket;
			try {
				socket = new WebSocket(this.wispUrl);
			} catch {
				resolve(false);
				return;
			}
			socket.binaryType = "arraybuffer";
			const timer = window.setTimeout(() => finish(false), 8000);
			socket.addEventListener("open", () => finish(true));
			socket.addEventListener("error", () => finish(false));
			socket.addEventListener("close", () => finish(false));
		});
	}

	async clearSiteData(): Promise<void> {
		const problems: string[] = [];
		if (this.controller) {
			try {
				this.controller.cookieJar.clear();
				await this.controller.persistCookies();
			} catch (error) {
				problems.push(`cookies (${error instanceof Error ? error.message : error})`);
			}
		}
		// Proxied sites' Web Storage lives in this origin, prefixed with their host ("example.com@key").
		for (const storage of [localStorage, sessionStorage]) {
			try {
				for (const key of Object.keys(storage)) if (!key.startsWith("deblocker:")) storage.removeItem(key);
			} catch {
				problems.push("web storage");
			}
		}
		try {
			if ("caches" in window) for (const name of await caches.keys()) await caches.delete(name);
		} catch {
			problems.push("cache storage");
		}
		try {
			const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
			await Promise.all(
				databases
					.map((db) => db.name)
					.filter((name): name is string => Boolean(name) && name !== "__scramjet_controller")
					.map(
						(name) =>
							new Promise<void>((resolve) => {
								const request = indexedDB.deleteDatabase(name);
								request.onsuccess = request.onerror = request.onblocked = () => resolve();
							}),
					),
			);
		} catch {
			problems.push("IndexedDB");
		}
		if (problems.length) throw new Error(`Some data couldn't be removed: ${problems.join(", ")}.`);
	}
}

export function createScramjetEngine(options: EngineOptions): ProxyEngine {
	return new ScramjetEngine(options);
}
