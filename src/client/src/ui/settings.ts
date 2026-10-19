import { SEARCH_ENGINES, type PublicConfig, type QuickLink } from "../../../shared/public-config.js";
import { resolveInput } from "../../../shared/url.js";
import { $, h, icon } from "../lib/dom.js";
import { THEMES, type Settings, type ThemeId } from "../lib/storage.js";

export type SettingsSection = "search" | "appearance" | "links" | "data";

export interface SettingsCallbacks {
	change(patch: Partial<Settings>): void;
	clearData(): Promise<void>;
	signOut(): Promise<void>;
}

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: string }> = [
	{ id: "search", label: "search", icon: "search" },
	{ id: "appearance", label: "appearance", icon: "palette" },
	{ id: "links", label: "quick links", icon: "bookmark" },
	{ id: "data", label: "privacy & data", icon: "shield" },
];

function row(badge: string, label: string, sub: string, control: Node, wrap = false): HTMLElement {
	return h(
		"div",
		{ class: wrap ? "row row-wrap" : "row" },
		h("span", { class: "row-badge", "aria-hidden": "true" }, icon(badge)),
		h("div", { class: "row-text" }, h("span", { class: "row-label" }, label), h("span", { class: "row-sub" }, sub)),
		h("div", { class: "row-control" }, control),
	);
}

function validTemplate(value: string): boolean {
	if (!value.includes("%s")) return false;
	try {
		const url = new URL(value.replace("%s", "test"));
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

export class SettingsView {
	private readonly root = $("view-settings");
	private section: SettingsSection = "search";

	constructor(
		private readonly callbacks: SettingsCallbacks,
		private getSettings: () => Settings,
		private getConfig: () => PublicConfig | null,
		private getLinks: () => QuickLink[],
		private getSession: () => { required: boolean; authenticated: boolean },
	) {}

	show(section?: SettingsSection) {
		if (section) this.section = section;
		this.render();
	}

	render() {
		const nav = h(
			"nav",
			{ class: "settings-nav", "aria-label": "Settings sections" },
			h("h2", { class: "settings-nav-title" }, "settings"),
			...SECTIONS.map((item) =>
				h(
					"button",
					{
						class: "settings-nav-btn",
						type: "button",
						"aria-current": item.id === this.section ? "true" : "false",
						onclick: () => this.show(item.id),
					},
					icon(item.icon),
					item.label,
				),
			),
		);
		const body = h("div", { class: "settings-body" }, this.renderSection());
		this.root.replaceChildren(h("div", { class: "settings" }, nav, body));
	}

	private renderSection(): HTMLElement {
		switch (this.section) {
			case "search":
				return this.searchSection();
			case "appearance":
				return this.appearanceSection();
			case "links":
				return this.linksSection();
			case "data":
				return this.dataSection();
		}
	}

	private sectionShell(id: SettingsSection, ...children: Node[]): HTMLElement {
		const meta = SECTIONS.find((s) => s.id === id)!;
		return h("section", { class: "settings-section" }, h("h3", { class: "section-label" }, icon(meta.icon), meta.label), ...children);
	}

	private searchSection(): HTMLElement {
		const settings = this.getSettings();
		const serverDefault = this.getConfig()?.searchEngine ?? SEARCH_ENGINES[0]!.template;
		const current = settings.searchEngine ?? serverDefault;
		const preset = SEARCH_ENGINES.find((engine) => engine.template === current);
		const defaultName = SEARCH_ENGINES.find((engine) => engine.template === serverDefault)?.name ?? "custom";

		const select = h(
			"select",
			{ class: "field", "aria-label": "Search engine" },
			...SEARCH_ENGINES.map((engine) => h("option", { value: engine.template, selected: engine.template === current }, engine.name)),
			h("option", { value: "custom", selected: !preset }, "Custom…"),
		);
		const custom = h("input", {
			class: "field",
			type: "url",
			placeholder: "https://search.example/?q=%s",
			value: preset ? "" : current,
			"aria-label": "Custom search URL",
			spellcheck: "false",
		});
		const error = h("p", { class: "form-error", hidden: true }, "Enter an http(s) address that contains %s where the search terms go.");
		const customRow = row("globe", "custom search address", "Use %s where the search terms should go.", h("div", { style: "width:100%" }, custom, error), true);
		customRow.hidden = Boolean(preset);

		select.addEventListener("change", () => {
			if (select.value === "custom") {
				customRow.hidden = false;
				custom.focus();
				return;
			}
			customRow.hidden = true;
			this.callbacks.change({ searchEngine: select.value === serverDefault ? null : select.value });
		});
		const commitCustom = () => {
			const value = custom.value.trim();
			const ok = validTemplate(value);
			error.hidden = ok || value === "";
			custom.setAttribute("aria-invalid", String(!ok && value !== ""));
			if (ok) this.callbacks.change({ searchEngine: value === serverDefault ? null : value });
		};
		custom.addEventListener("change", commitCustom);
		custom.addEventListener("keydown", (event) => {
			if (event.key === "Enter") commitCustom();
		});

		return this.sectionShell(
			"search",
			row("search", "search engine", `Used when what you type isn't a web address. Server default: ${defaultName}.`, select),
			customRow,
		);
	}

	private appearanceSection(): HTMLElement {
		const settings = this.getSettings();
		const swatches = h(
			"div",
			{ class: "swatches", role: "radiogroup", "aria-label": "Colour theme" },
			...THEMES.map((theme) =>
				h(
					"button",
					{
						class: "swatch",
						type: "button",
						role: "radio",
						"aria-checked": String(theme.id === settings.theme),
						onclick: () => {
							this.callbacks.change({ theme: theme.id as ThemeId });
							this.render();
						},
					},
					h("span", { class: "swatch-dot", style: `background: linear-gradient(135deg, ${theme.swatch[0]} 50%, ${theme.swatch[1]} 50%)` }),
					theme.name.toLowerCase(),
				),
			),
		);
		const backdrop = h("button", {
			class: "switch",
			type: "button",
			role: "switch",
			"aria-checked": String(settings.backdrop),
			"aria-label": "Show background art",
			onclick: () => {
				this.callbacks.change({ backdrop: !this.getSettings().backdrop });
				this.render();
			},
		});
		return this.sectionShell(
			"appearance",
			row("palette", "colour theme", "Changes the accent and the tint of the interface.", swatches, true),
			row("maximize", "background art", "Show the night-ridge illustration behind the interface.", backdrop),
		);
	}

	private linksSection(): HTMLElement {
		const links = this.getLinks().map((link) => ({ ...link }));
		const list = h("div", { class: "links-editor" });
		const error = h("p", { class: "form-error", hidden: true });

		const save = (next: QuickLink[]) => {
			this.callbacks.change({ quickLinks: next });
		};

		const draw = () => {
			if (links.length === 0) {
				list.replaceChildren(h("p", { class: "empty-note" }, "No quick links yet. Add one below."));
				return;
			}
			list.replaceChildren(
				...links.map((link, index) => {
					const title = h("input", { class: "field", value: link.title, maxlength: 40, "aria-label": `Title of link ${index + 1}`, placeholder: "title" });
					const url = h("input", { class: "field link-url", value: link.url, "aria-label": `Address of link ${index + 1}`, placeholder: "example.com", spellcheck: "false" });
					const mono = h("span", { class: "link-row-mono", "aria-hidden": "true" }, [...(link.title || "?")][0]!);
					title.addEventListener("input", () => (mono.textContent = [...(title.value || "?")][0]!));
					title.addEventListener("change", () => {
						link.title = title.value.trim() || link.title;
						title.value = link.title;
						save(links);
					});
					url.addEventListener("change", () => {
						const resolved = resolveInput(url.value, "https://example.invalid/?q=%s");
						if (resolved.kind !== "url") {
							url.setAttribute("aria-invalid", "true");
							error.hidden = false;
							error.textContent = "Quick links need a full web address, like example.com or https://example.com/page.";
							return;
						}
						url.setAttribute("aria-invalid", "false");
						error.hidden = true;
						link.url = resolved.url;
						url.value = resolved.url;
						save(links);
					});
					const move = (delta: number) => {
						const target = index + delta;
						if (target < 0 || target >= links.length) return;
						[links[index], links[target]] = [links[target]!, links[index]!];
						save(links);
						draw();
					};
					return h(
						"div",
						{ class: "link-row" },
						mono,
						title,
						url,
						h(
							"div",
							{ class: "link-row-actions" },
							h("button", { class: "icon-btn", type: "button", title: "Move up", "aria-label": "Move up", disabled: index === 0, onclick: () => move(-1) }, icon("arrow-up")),
							h(
								"button",
								{ class: "icon-btn", type: "button", title: "Move down", "aria-label": "Move down", disabled: index === links.length - 1, onclick: () => move(1) },
								icon("arrow-down"),
							),
							h(
								"button",
								{
									class: "icon-btn danger",
									type: "button",
									title: "Remove",
									"aria-label": `Remove ${link.title}`,
									onclick: () => {
										links.splice(index, 1);
										save(links);
										draw();
									},
								},
								icon("trash"),
							),
						),
					);
				}),
			);
		};
		draw();

		const newTitle = h("input", { class: "field", placeholder: "title", maxlength: 40, "aria-label": "New link title" });
		const newUrl = h("input", { class: "field link-url", placeholder: "example.com", "aria-label": "New link address", spellcheck: "false" });
		const addForm = h(
			"form",
			{
				class: "link-row",
				onsubmit: (event: Event) => {
					event.preventDefault();
					const resolved = resolveInput(newUrl.value, "https://example.invalid/?q=%s");
					if (resolved.kind !== "url") {
						error.hidden = false;
						error.textContent = "Enter a full web address, like example.com or https://example.com/page.";
						newUrl.setAttribute("aria-invalid", "true");
						return;
					}
					if (links.length >= 24) {
						error.hidden = false;
						error.textContent = "You can keep up to 24 quick links.";
						return;
					}
					error.hidden = true;
					newUrl.setAttribute("aria-invalid", "false");
					const host = new URL(resolved.url).hostname.replace(/^www\./, "");
					links.push({ title: newTitle.value.trim() || host, url: resolved.url });
					newTitle.value = "";
					newUrl.value = "";
					save(links);
					draw();
				},
			},
			h("span", { class: "link-row-mono", "aria-hidden": "true" }, icon("plus")),
			newTitle,
			newUrl,
			h("button", { class: "btn btn-accent", type: "submit" }, "add"),
		);

		const reset = h(
			"button",
			{
				class: "btn",
				type: "button",
				onclick: () => {
					this.callbacks.change({ quickLinks: null });
					this.render();
				},
			},
			icon("rotate-cw"),
			"restore defaults",
		);

		return this.sectionShell(
			"links",
			h("p", { class: "row-sub", style: "margin:0 0 6px" }, "Shown on the home page. Stored only in this browser."),
			list,
			addForm,
			error,
			h("div", { class: "links-footer" }, reset),
		);
	}

	private dataSection(): HTMLElement {
		const clear = h(
			"button",
			{
				class: "btn btn-danger",
				type: "button",
				onclick: async () => {
					clear.disabled = true;
					await this.callbacks.clearData();
					clear.disabled = false;
				},
			},
			icon("trash"),
			"clear data",
		);
		const rows: Node[] = [
			row(
				"trash",
				"clear site data",
				"Closes all tabs and removes cookies, storage and cached files that proxied sites saved in this browser. Your Deblocker settings are kept.",
				clear,
			),
			row(
				"lock",
				"what the server can see",
				"Pages load through an encrypted tunnel: your browser negotiates TLS with each site, so this server relays encrypted traffic and sees which hosts you connect to, not page contents (except for plain http:// sites).",
				h("span"),
			),
		];
		const session = this.getSession();
		if (session.required) {
			rows.push(
				row(
					"key",
					"access key",
					"This server requires an access key. Signing out removes the session cookie from this browser.",
					h("button", { class: "btn", type: "button", onclick: () => void this.callbacks.signOut() }, "sign out"),
				),
			);
		}
		return this.sectionShell("data", ...rows);
	}
}
