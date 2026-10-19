type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** Tiny element factory: h("button", { class: "btn", onclick: fn }, "label"). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === null || value === undefined || value === false) continue;
		if (key.startsWith("on") && typeof value === "function") {
			element.addEventListener(key.slice(2), value);
		} else if (key in element && key !== "list" && key !== "form" && typeof value !== "string") {
			(element as unknown as Record<string, unknown>)[key] = value;
		} else {
			element.setAttribute(key, value === true ? "" : String(value));
		}
	}
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		element.append(child);
	}
	return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** References one of the <symbol> icons defined in index.html. */
export function icon(name: string, className = ""): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", `icon ${className}`.trim());
	svg.setAttribute("aria-hidden", "true");
	const use = document.createElementNS(SVG_NS, "use");
	use.setAttribute("href", `#i-${name}`);
	svg.append(use);
	return svg;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing element #${id}`);
	return element as T;
}
