import { $, h, icon } from "../lib/dom.js";

export interface ToastAction {
	label: string;
	icon: string;
	run: () => void;
}

export interface ToastOptions {
	title: string;
	message?: string;
	tone?: "info" | "error";
	actions?: ToastAction[];
	/** Milliseconds before auto-dismiss; 0 keeps it until dismissed. */
	timeout?: number;
	/** Toasts with the same key replace each other instead of stacking. */
	key?: string;
}

const open = new Map<string, HTMLElement>();

export function toast(options: ToastOptions): () => void {
	const container = $("toasts");
	const key = options.key ?? `${Date.now()}-${Math.random()}`;
	open.get(key)?.remove();

	const dismiss = () => {
		element.remove();
		if (open.get(key) === element) open.delete(key);
	};

	const buttons = (options.actions ?? []).map((action) =>
		h(
			"button",
			{
				class: "icon-btn",
				type: "button",
				title: action.label,
				"aria-label": action.label,
				onclick: () => {
					dismiss();
					action.run();
				},
			},
			icon(action.icon),
		),
	);
	buttons.push(h("button", { class: "icon-btn", type: "button", title: "Dismiss", "aria-label": "Dismiss", onclick: dismiss }, icon("x")));

	const element = h(
		"div",
		{ class: "toast", role: options.tone === "error" ? "alert" : "status", "data-tone": options.tone ?? "info" },
		h("div", { class: "toast-body" }, h("strong", {}, options.title), options.message ?? ""),
		h("div", { class: "toast-actions" }, ...buttons),
	);
	container.append(element);
	open.set(key, element);

	const timeout = options.timeout ?? (options.tone === "error" ? 0 : 5000);
	if (timeout > 0) setTimeout(dismiss, timeout);
	return dismiss;
}

export function dismissToast(key: string): void {
	open.get(key)?.remove();
	open.delete(key);
}
