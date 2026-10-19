/**
 * Types and constants shared by the server and the browser client.
 * Everything in PublicConfig is sent to every visitor, so it must never contain secrets.
 */

export type TransportName = "libcurl" | "epoxy";

export interface QuickLink {
	title: string;
	url: string;
}

export interface SearchEngine {
	id: string;
	name: string;
	/** URL template; "%s" is replaced with the URL-encoded query. */
	template: string;
}

export const SEARCH_ENGINES: readonly SearchEngine[] = [
	{ id: "duckduckgo", name: "DuckDuckGo", template: "https://duckduckgo.com/?q=%s" },
	{ id: "google", name: "Google", template: "https://www.google.com/search?q=%s" },
	{ id: "bing", name: "Bing", template: "https://www.bing.com/search?q=%s" },
	{ id: "brave", name: "Brave Search", template: "https://search.brave.com/search?q=%s" },
	{ id: "startpage", name: "Startpage", template: "https://www.startpage.com/do/search?q=%s" },
	{ id: "wikipedia", name: "Wikipedia", template: "https://en.wikipedia.org/w/index.php?search=%s" },
];

export interface PublicConfig {
	version: string;
	transport: TransportName;
	accessKeyRequired: boolean;
	/** Default search URL template chosen by the operator. Visitors can override it locally. */
	searchEngine: string;
	quickLinks: QuickLink[];
	engine: {
		scramjet: string;
		controller: string;
		transport: string;
	};
	policy: {
		ports: number[] | "any";
		allowlistActive: boolean;
		privateDestinations: boolean;
	};
}

export interface SessionState {
	required: boolean;
	authenticated: boolean;
}
