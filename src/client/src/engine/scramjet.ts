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
import type { EngineStatus, FrameEvents, NavigationErrorKind, NavigationKind, ProxyEngine, ProxyFrame } from "./types.js";

/* Minimal shapes of the runtime globals defined by the engine bundles. */
interface ScramjetFrame {
	prefix: string;
	element: HTMLIFrameElement;
	context: unknown;
	hooks: {
		init: { post: unknown };
		error: { request: unknown };
		fetch: { preresponse: unknown };
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function activated(worker: ServiceWorker): Promise<void> {
	if (worker.state === "activated") return Promise.resolve();
	return new Promise((resolve) => {
		const onChange = () => {
			if (worker.state === "activated" || worker.state === "redundant") {
				worker.removeEventListener("statechange", onChange);
				resolve();
			}
		};
		worker.addEventListener("statechange", onChange);
	});
}

/**
 * Registers sw.js and waits until the newest version is the active worker. After a deploy the old
 * worker is replaced within moments (skipWaiting + clients.claim); handing the Controller the old,
 * soon-redundant worker would leave the engine waiting forever.
 */
async function registerServiceWorker(base: string): Promise<ServiceWorkerRegistration> {
	const registration = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base, updateViaCache: "none" });
	await Promise.race([registration.update().catch(() => {}), sleep(3000)]);
	const pending = registration.installing ?? registration.waiting;
	if (pending) await Promise.race([activated(pending), sleep(5000)]);
	await navigator.serviceWorker.ready;
	return registration;
}

function currentWorker(registration: ServiceWorkerRegistration): ServiceWorker | null {
	const controller = navigator.serviceWorker.controller;
	if (controller && controller.state !== "redundant") return controller;
	return registration.active;
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

interface FailureRecord {
	kind: NavigationErrorKind;
	detail: string;
}

class ScramjetProxyFrame implements ProxyFrame {
	readonly iframe: HTMLIFrameElement;
	private frame: ScramjetFrame | null = null;
	private lastUrl: string | null = null;
	private titleObserver: MutationObserver | null = null;
	private destroyed = false;
	/** The current document called location.replace(), so its successor replaces its history entry. */
	private replacing = false;
	private errored = false;
	/** Top-level load failures recorded by the engine, keyed by real URL (pages can't forge these). */
	private readonly failures = new Map<string, FailureRecord>();

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

	get showingError(): boolean {
		return this.errored;
	}

	go(url: string): void {
		if (this.destroyed) return;
		// Forget the previous URL so the next commit is always reported, even if a redirect
		// lands on the page that was already showing.
		this.lastUrl = null;
		this.errored = false;
		this.replacing = false;
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
			documentCommitted: (url, kind, win) => {
				const effective = this.replacing ? "replace" : kind;
				this.replacing = false;
				this.errored = false;
				this.setUrl(url, effective);
				this.watchDocument(win);
			},
			urlChanged: (url, kind) => this.setUrl(url, kind),
			willReplace: () => (this.replacing = true),
			requestFailed: (url, kind, detail) => {
				if (this.failures.size > 20) this.failures.clear();
				this.failures.set(url, { kind, detail });
			},
			navigationEnded: () => this.events.loadFinished(),
		});
		return this.frame;
	}

	private setUrl(url: string, kind: NavigationKind) {
		if (url === this.lastUrl) return;
		this.lastUrl = url;
		this.events.urlChanged(url, kind);
	}

	/** Called for every new top-level document Scramjet initialises in this frame. */
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
		// Forward Deblocker's keyboard shortcuts while the page has focus (the handler ignores keys
		// that edit text, so typing in the page is never affected).
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
		const url = this.currentUrl;
		const record = url ? this.failures.get(url) : undefined;
		// Only documents the engine itself produced for a failed load count as errors; a page that merely
		// carries the marker attribute is treated like any other page.
		if (url && record && doc?.documentElement?.hasAttribute(`data-${ERROR_MARKER}`)) {
			this.failures.delete(url);
			this.errored = true;
			const kind = this.replacing ? "replace" : "push";
			this.replacing = false;
			this.setUrl(url, kind);
			this.events.titleChanged("");
			this.events.faviconChanged(null);
			this.events.failed({ url, kind: record.kind, detail: record.detail });
			return;
		}
		this.errored = false;
		if (url) this.setUrl(url, "push");
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
	/** A new top-level document was initialised. */
	documentCommitted(url: string, kind: NavigationKind, win: Window): void;
	/** Same-document URL change (pushState, replaceState, hash, back/forward within the page). */
	urlChanged(url: string, kind: NavigationKind): void;
	/** The page called location.replace(). */
	willReplace(): void;
	/** A top-level navigation failed in the engine; an error document is about to load. */
	requestFailed(url: string, kind: NavigationErrorKind, detail: string): void;
	/** A top-level navigation ended without a new document (download, 204). */
	navigationEnded(): void;
}

type SocketLike = { close(code?: number, reason?: string): void; addEventListener(type: string, listener: () => void): void };

/** Maps form targets that would leave the tab (_top, _parent) onto the frames Scramjet uses for them. */
function installFormTargets(client: any, win: Window) {
	const mapTarget = (target: string | null | undefined): string | null => {
		const value = (target ?? "").trim().toLowerCase();
		if (value === "_top" || value === "_unfencedtop") return client.meta?.topFrameName ?? "_self";
		if (value === "_parent") return client.meta?.parentFrameName ?? "_self";
		return null;
	};
	const fix = (form: HTMLFormElement, submitter?: Element | null) => {
		const override = submitter?.getAttribute("formtarget");
		if (submitter && override !== null && override !== undefined) {
			const mapped = mapTarget(override);
			if (mapped) submitter.setAttribute("formtarget", mapped);
			return;
		}
		const mapped = mapTarget(form.getAttribute("target") ?? win.document.querySelector("base[target]")?.getAttribute("target"));
		if (mapped) form.setAttribute("target", mapped);
	};
	win.addEventListener(
		"submit",
		(event) => {
			const form = event.target as HTMLFormElement | null;
			if (form && form.tagName === "FORM") fix(form, (event as SubmitEvent).submitter);
		},
		{ capture: true },
	);
	// form.submit() fires no submit event.
	client.Proxy(["HTMLFormElement.prototype.submit"], {
		apply(call: { this: HTMLFormElement }) {
			if (call.this) fix(call.this);
		},
	});
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
		const registration = await withTimeout(registerServiceWorker(base), START_TIMEOUT_MS, "The service worker took too long to start.");

		await loadScript(`${base}engine/scramjet.js`);
		await loadScript(`${base}engine/controller.api.js`);
		await Promise.all([loadScript(`${base}engine/scramjet-utils.js`), loadScript(`${base}engine/transport.js`)]);

		const transport = this.createTransport();
		const api = window.$scramjetController;
		if (!api) throw new Error("Scramjet Controller failed to load.");
		const worker = currentWorker(registration);
		if (!worker) throw new Error("The service worker didn't activate.");
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
		const controller = this.controller as ScramjetController & Record<string, any>;
		// Each service worker restart makes the page re-register its port. Both sw.js and controller.sw.js
		// announce a restart, so ignore repeat announcements for a moment: a second re-registration
		// would orphan requests already in flight on the first port.
		const setupPort = controller.setupMessagePort.bind(controller) as () => void;
		let guardTimer: number | undefined;
		controller.setupMessagePort = () => {
			controller.guardServiceWorkerRevive = true;
			window.clearTimeout(guardTimer);
			guardTimer = window.setTimeout(() => (controller.guardServiceWorkerRevive = false), 1500);
			setupPort();
		};
		// After a service worker update, talk to the new worker (also needed if it activates during start-up).
		navigator.serviceWorker.addEventListener("controllerchange", () => {
			const active = navigator.serviceWorker.controller;
			if (active && active !== controller.serviceWorkerController) {
				controller.serviceWorkerController = active;
				controller.setupMessagePort();
			}
		});

		await withTimeout(this.controller.wait(), START_TIMEOUT_MS, "Scramjet took too long to start. Try reloading the page.");
		// The controller ignores restart announcements for 5 s after start-up, which would leave Deblocker
		// broken if the worker restarted in that window. The guard above handles duplicates instead.
		window.clearTimeout(guardTimer);
		controller.guardServiceWorkerRevive = false;
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
		const cache = utils ? new utils.HttpCachePlugin() : null;
		const frame = controller.createFrame(iframe, { plugins: cache ? [cache] : [] });
		const plugin = new scramjet.Plugin("deblocker");

		// scramjet-utils 0.0.3's HttpCachePlugin rebuilds cacheable responses with `new Response()`, which
		// silently drops Set-Cookie, so sign-ins and other cookies would be lost. Mark such responses as
		// already handled so the cache plugin leaves them untouched (it checks this map first).
		const handled = (cache as { cameFromCache?: unknown } | null)?.cameFromCache;
		if (handled instanceof WeakMap) {
			plugin.tap(
				frame.hooks.fetch.preresponse,
				(context: { request: object }, props: { response: { rawHeaders: Array<[string, string]> } }) => {
					if (props.response.rawHeaders.some(([name]) => /^set-cookie2?$/i.test(name))) handled.set(context.request, true);
				},
				{ before: ["scramjet-http-cache"] },
			);
		}

		plugin.tap(frame.hooks.init.post, (context: { isTopLevel: boolean; window: Window; client: any }) => {
			try {
				const { client, window: win } = context;
				let replacingState = false;
				// Published Scramjet 2.0.67-alpha.2 turns history.pushState(state, title) without a URL into
				// ".../undefined" (fixed upstream on main). Fill in the current URL, as browsers do.
				const fillUrl = (call: { args: unknown[] }) => {
					if (call.args[2] === undefined || call.args[2] === null) call.args[2] = client.url.href;
				};
				client.Proxy(["History.prototype.pushState"], { apply: fillUrl });
				client.Proxy(["History.prototype.replaceState"], {
					apply(call: { args: unknown[] }) {
						fillUrl(call);
						replacingState = true;
					},
				});

				// WebSockets opened by the page live in the Deblocker page's transport, which never learns
				// that the document went away; close them when it does, so Wisp streams aren't leaked.
				const bare = client.bare;
				if (bare && typeof bare.createWebSocket === "function") {
					const sockets = new Set<SocketLike>();
					const create = bare.createWebSocket.bind(bare) as (...args: unknown[]) => SocketLike;
					bare.createWebSocket = (...args: unknown[]) => {
						const socket = create(...args);
						sockets.add(socket);
						socket.addEventListener("close", () => sockets.delete(socket));
						return socket;
					};
					win.addEventListener("pagehide", () => {
						for (const socket of sockets) {
							try {
								socket.close(1001, "");
							} catch {
								// still connecting
							}
						}
						sockets.clear();
					});
				}

				installFormTargets(client, win);

				if (!context.isTopLevel) return;
				const current = () => client.url.href as string;
				const navigation = win.performance?.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
				const kind: NavigationKind = navigation?.type === "back_forward" ? "traverse" : navigation?.type === "reload" ? "replace" : "push";
				callbacks.documentCommitted(current(), kind, win);

				const locationProxy = client.locationProxy;
				if (locationProxy && typeof locationProxy.replace === "function") {
					locationProxy.replace = new Proxy(locationProxy.replace, {
						apply(target, that, args) {
							callbacks.willReplace();
							return Reflect.apply(target, that, args);
						},
					});
				}
				// "location" events carry a relative or stale URL and are followed by a new document anyway.
				plugin.tap(client.hooks.lifecycle.navigate, (event: { type?: string }) => {
					if (event?.type === "location") return;
					const change: NavigationKind = event?.type === "history" && replacingState ? "replace" : "push";
					replacingState = false;
					callbacks.urlChanged(current(), change);
				});
				win.addEventListener("popstate", () => callbacks.urlChanged(current(), "traverse"), { capture: true });
				win.addEventListener("hashchange", () => callbacks.urlChanged(current(), "push"), { capture: true });
			} catch (error) {
				console.warn("Deblocker: couldn't attach to a proxied document", error);
			}
		});

		// Navigations that end without a document (downloads, 204 No Content) never fire "load".
		plugin.tap(frame.hooks.fetch.preresponse, (context: { parsed: { destination: string; isIframe?: boolean } }, props: { response: { status: number; rawHeaders: Array<[string, string]> } }) => {
			if (context.parsed.destination !== "iframe" || context.parsed.isIframe) return;
			const { status, rawHeaders } = props.response;
			const disposition = rawHeaders.find(([name]) => /^content-disposition$/i.test(name))?.[1] ?? "";
			if (status === 204 || status === 205 || /^\s*attachment/i.test(disposition)) callbacks.navigationEnded();
		});

		// Failed page loads get an error document; ScramjetProxyFrame shows Deblocker's error card for it.
		plugin.tap(frame.hooks.error.request, (context: { rawrequest: { rawUrl: string; destination: string }; error: unknown }, props: any) => {
			const destination = context.rawrequest.destination;
			if (destination !== "document" && destination !== "iframe") return;
			const { kind, detail } = classifyError(context.error);
			const url = decodeFrameUrl(frame, context.rawrequest.rawUrl) ?? context.rawrequest.rawUrl;
			let nested = false;
			try {
				nested = new URL(context.rawrequest.rawUrl).searchParams.has("$iframe");
			} catch {
				// ignore
			}
			if (!nested) callbacks.requestFailed(url, kind, detail);
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
		try {
			// Scramjet keeps proxied sites' file system storage (OPFS) in per-site folders of this origin's root.
			if (navigator.storage && typeof navigator.storage.getDirectory === "function") {
				const root = await navigator.storage.getDirectory();
				const names: string[] = [];
				for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
				for (const name of names) await root.removeEntry(name, { recursive: true });
			}
		} catch {
			problems.push("file storage");
		}
		if (problems.length) throw new Error(`Some data couldn't be removed: ${problems.join(", ")}.`);
	}
}

export function createScramjetEngine(options: EngineOptions): ProxyEngine {
	return new ScramjetEngine(options);
}
