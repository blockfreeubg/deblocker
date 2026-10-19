import type { PublicConfig } from "../../../shared/public-config.js";
import { $, h } from "../lib/dom.js";

const SHORTCUTS: Array<[string, string[]]> = [
	["Focus the address bar", ["Ctrl", "L"]],
	["Open address", ["Enter"]],
	["New tab", ["Alt", "T"]],
	["Close tab", ["Alt", "W"]],
	["Back / forward", ["Alt", "← / →"]],
	["Reload", ["Alt", "R"]],
	["Home", ["Alt", "Home"]],
	["Switch to tab 1–9", ["Alt", "1–9"]],
];

const CREDITS: Array<[string, string, string]> = [
	["Scramjet", "AGPL-3.0", "https://github.com/MercuryWorkshop/scramjet"],
	["Scramjet Controller", "AGPL-3.0", "https://github.com/MercuryWorkshop/scramjet/tree/main/packages/controller"],
	["libcurl transport", "AGPL-3.0", "https://github.com/MercuryWorkshop/CurlTransport"],
	["Epoxy transport", "AGPL-3.0", "https://github.com/MercuryWorkshop/epoxy-transport"],
	["wisp-js", "LGPL-3.0", "https://github.com/MercuryWorkshop/wisp-js"],
	["Inter typeface", "OFL-1.1", "https://rsms.me/inter/"],
	["Lucide icons", "ISC", "https://lucide.dev"],
	["Express", "MIT", "https://expressjs.com"],
];

function fact(name: string, value: string): HTMLElement {
	return h("div", { class: "fact" }, h("span", { class: "fact-name" }, name), h("span", { class: "fact-value" }, value));
}

export function renderAbout(config: PublicConfig | null): void {
	const root = $("view-about");
	const ports = config ? (config.policy.ports === "any" ? "any" : config.policy.ports.join(", ")) : "unknown";
	const mark = document.querySelector(".brand-mark")!.cloneNode(true);

	root.replaceChildren(
		h(
			"div",
			{ class: "page" },
			h(
				"header",
				{ class: "page-head" },
				mark,
				h("div", {}, h("h1", { class: "page-title" }, "About Deblocker"), h("p", { class: "page-sub" }, `version ${config?.version ?? "unknown"} · powered by Scramjet`)),
			),
			h(
				"section",
				{ class: "page-section" },
				h("h2", { class: "section-label" }, "what it is"),
				h(
					"p",
					{},
					"Deblocker is a self-hosted web proxy for everyday browsing, testing and research. Pages you open are fetched and rewritten inside your own browser by Scramjet, so they display here as if you had visited them directly.",
				),
				h(
					"ol",
					{ class: "flow" },
					h("li", {}, h("strong", {}, "1 · your browser"), "A service worker intercepts the page's requests."),
					h("li", {}, h("strong", {}, "2 · Scramjet"), "Rewrites HTML, CSS and JavaScript so links stay inside Deblocker."),
					h("li", {}, h("strong", {}, `3 · ${config?.transport ?? "transport"}`), "Encrypts traffic in the browser and tunnels it over a Wisp WebSocket."),
					h("li", {}, h("strong", {}, "4 · this server"), "Opens the TCP connection to the site and relays the bytes."),
				),
			),
			h(
				"section",
				{ class: "page-section" },
				h("h2", { class: "section-label" }, "good to know"),
				h(
					"ul",
					{},
					h("li", {}, "Not every site works through a proxy. Sites with strict bot protection, DRM video, WebRTC calls, or sign-in flows that check where you connect from may fail or ask for extra verification."),
					h("li", {}, "Sites see this server's IP address, not yours. The server sees which hosts you connect to, but HTTPS page contents stay encrypted end to end."),
					h("li", {}, "Cookies and storage from proxied sites are kept in this browser until you clear them in settings."),
					h("li", {}, "Use Deblocker responsibly and follow the rules of the networks and services you use."),
				),
			),
			h(
				"section",
				{ class: "page-section" },
				h("h2", { class: "section-label" }, "this server"),
				h(
					"div",
					{ class: "facts" },
					fact("Proxy engine", config ? `Scramjet ${config.engine.scramjet} · controller ${config.engine.controller}` : "unknown"),
					fact("Transport", config ? `${config.engine.transport} over Wisp` : "unknown"),
					fact("Allowed destination ports", ports),
					fact("Destination allowlist", config ? (config.policy.allowlistActive ? "active (only approved sites)" : "not active") : "unknown"),
					fact("Local / private networks", config ? (config.policy.privateDestinations ? "allowed (development mode)" : "blocked") : "unknown"),
					fact("Access key", config ? (config.accessKeyRequired ? "required" : "not required") : "unknown"),
				),
			),
			h(
				"section",
				{ class: "page-section" },
				h("h2", { class: "section-label" }, "keyboard shortcuts"),
				h(
					"div",
					{ class: "shortcuts" },
					...SHORTCUTS.map(([label, keys]) =>
						h("div", { class: "shortcut" }, h("span", {}, label), h("span", { class: "shortcut-keys" }, ...keys.map((key) => h("kbd", {}, key)))),
					),
				),
				h("p", { class: "row-sub" }, "Shortcuts work while the Deblocker interface has focus. Click the address bar if a page has captured the keyboard."),
			),
			h(
				"section",
				{ class: "page-section" },
				h("h2", { class: "section-label" }, "open source"),
				h(
					"div",
					{ class: "facts" },
					...CREDITS.map(([name, license, url]) =>
						h(
							"div",
							{ class: "fact" },
							h("a", { class: "fact-name", href: url, target: "_blank", rel: "noopener noreferrer" }, name),
							h("span", { class: "fact-value" }, license),
						),
					),
				),
				h(
					"p",
					{ class: "row-sub" },
					"Scramjet and its transports are licensed under the GNU AGPL-3.0; their source code is available at the links above. Deblocker's own code is MIT licensed.",
				),
			),
		),
	);
}
