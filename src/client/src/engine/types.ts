/** Why a top-level page failed to load, normalised from whatever the engine/transport reported. */
export type NavigationErrorKind = "blocked" | "dns" | "refused" | "unreachable" | "timeout" | "tls" | "transport" | "unknown";

export interface NavigationError {
	kind: NavigationErrorKind;
	url: string;
	detail: string;
}

export interface FrameEvents {
	/** The real (un-proxied) URL of the top-level page changed: navigation, redirect or history.pushState. */
	urlChanged(url: string): void;
	titleChanged(title: string): void;
	faviconChanged(href: string | null): void;
	loadStarted(): void;
	loadFinished(): void;
	/** The top-level document could not be loaded. */
	failed(error: NavigationError): void;
}

export interface ProxyFrame {
	readonly iframe: HTMLIFrameElement;
	/** Real URL currently displayed, if any page has committed yet. */
	readonly currentUrl: string | null;
	go(url: string): void;
	reload(): void;
	stop(): void;
	destroy(): void;
}

export type EngineStatus = "starting" | "ready" | "failed";

export interface ProxyEngine {
	readonly status: EngineStatus;
	readonly failure: string | null;
	/** Resolves once the service worker, controller and transport are ready (or rejects with a readable message). */
	ready(): Promise<void>;
	createFrame(container: HTMLElement, events: FrameEvents): ProxyFrame;
	/** Checks that the Wisp backend accepts connections. */
	checkBackend(): Promise<boolean>;
	/** Removes data proxied sites stored in this browser (cookies, storage, caches). */
	clearSiteData(): Promise<void>;
}
