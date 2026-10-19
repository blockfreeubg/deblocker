import type { QuickLink } from "../../../shared/public-config.js";
import { hostLabel } from "../../../shared/url.js";
import { $, h, icon } from "../lib/dom.js";

export interface HomeCallbacks {
	submit(input: string): void;
	openLink(url: string, newTab: boolean): void;
	editLinks(): void;
	unlock(key: string): Promise<string | null>;
}

/** Splits the wordmark into letters for the staggered entrance and per-letter hover. */
function animateWordmark() {
	const wordmark = $("wordmark");
	const text = wordmark.textContent ?? "";
	wordmark.textContent = "";
	[...text].forEach((char, index) => {
		const span = h("span", { class: index < 2 ? "char accent" : "char", "aria-hidden": "true" }, char);
		span.style.animationDelay = `${index * 0.045}s`;
		wordmark.append(span);
	});
}

export class HomeView {
	private readonly input = $<HTMLInputElement>("homeInput");
	private readonly form = $<HTMLFormElement>("homeSearch");
	private readonly message = $("homeMessage");
	private readonly links = $("quickLinks");
	private readonly unlockForm = $<HTMLFormElement>("unlockForm");
	private readonly unlockInput = $<HTMLInputElement>("unlockInput");
	private readonly unlockError = $("unlockError");

	constructor(private readonly callbacks: HomeCallbacks) {
		animateWordmark();
		this.form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.callbacks.submit(this.input.value);
		});
		this.input.addEventListener("input", () => this.showMessage(null));
		this.unlockForm.addEventListener("submit", async (event) => {
			event.preventDefault();
			const button = this.unlockForm.querySelector("button");
			if (button) button.disabled = true;
			const error = await this.callbacks.unlock(this.unlockInput.value);
			if (button) button.disabled = false;
			this.unlockError.hidden = error === null;
			this.unlockError.textContent = error ?? "";
			if (error === null) this.unlockInput.value = "";
			else this.unlockInput.select();
		});
	}

	focus() {
		if (!this.unlockForm.hidden) this.unlockInput.focus();
		else this.input.focus({ preventScroll: true });
	}

	clear() {
		this.input.value = "";
		this.setBusy(false);
		this.showMessage(null);
	}

	setBusy(busy: boolean) {
		this.form.classList.toggle("is-busy", busy);
	}

	showMessage(text: string | null) {
		this.message.hidden = text === null;
		this.message.textContent = text ?? "";
	}

	setLocked(locked: boolean) {
		this.unlockForm.hidden = !locked;
		this.form.hidden = locked;
		this.links.hidden = locked;
	}

	renderLinks(links: QuickLink[]) {
		const tiles = links.map((link) => {
			const label = link.title || hostLabel(link.url);
			return h(
				"a",
				{
					class: "quicklink",
					href: link.url,
					title: `${label} — ${link.url}`,
					onclick: (event: Event) => {
						const mouse = event as MouseEvent;
						event.preventDefault();
						this.callbacks.openLink(link.url, mouse.ctrlKey || mouse.metaKey || mouse.shiftKey);
					},
					onauxclick: (event: Event) => {
						if ((event as MouseEvent).button !== 1) return;
						event.preventDefault();
						this.callbacks.openLink(link.url, true);
					},
				},
				h("span", { class: "quicklink-icon", "aria-hidden": "true" }, [...label][0] ?? "•"),
				h("span", { class: "quicklink-label" }, label),
			);
		});
		const edit = h(
			"button",
			{ class: "quicklink is-edit", type: "button", title: "Edit quick links", onclick: () => this.callbacks.editLinks() },
			h("span", { class: "quicklink-icon", "aria-hidden": "true" }, icon(links.length ? "pencil" : "plus")),
			h("span", { class: "quicklink-label" }, links.length ? "edit" : "add link"),
		);
		this.links.replaceChildren(...tiles, edit);
	}
}
