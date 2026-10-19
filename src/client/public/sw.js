/*
 * Deblocker service worker.
 *
 * Scramjet Controller does the real work (controller.sw.js): it forwards every request under a
 * frame's prefix to the Deblocker page that owns that frame, where Scramjet rewrites it and the
 * transport fetches it over Wisp. This file adds the robustness the stock example lacks:
 *
 *  - Browsers stop idle service workers. A request that wakes this worker arrives before the open
 *    pages have re-registered their prefixes, so we ask them to reconnect (once per restart) and wait
 *    briefly instead of letting the request fall through to the network, where it would 404.
 *  - A proxied URL opened as a top-level page (a link opened in a new tab, window.open, a copied
 *    link, a page from an old session) is sent back into the Deblocker interface.
 *  - Requests for a prefix whose page is gone (Deblocker was reloaded or closed) fail straight away
 *    instead of waiting forever.
 */
importScripts("./engine/controller.sw.js");

const SCOPE = new URL(self.registration.scope).pathname;
const PROXY_PREFIX = `${SCOPE}~/sj/`;
const REVIVE_TIMEOUT_MS = 6000;
// Last-resort limit for a response to start (the browser's own fetch-event limit is about 5 minutes).
const ROUTE_TIMEOUT_MS = 280000;

/** Which window registered each controller prefix, so requests from dead sessions can be detected. */
const owners = new Map();
addEventListener("message", (event) => {
	const init = event.data && event.data.$controller$init;
	if (init && typeof init.prefix === "string" && event.source) owners.set(init.prefix, event.source.id);
});

/** Proxied URLs look like <prefix><controller id>/<frame id>/<encodeURIComponent(real URL)>. */
function realUrlOf(url) {
	const encoded = url.pathname.slice(PROXY_PREFIX.length).split("/").slice(2).join("/");
	try {
		const real = decodeURIComponent(encoded);
		return /^https?:\/\//i.test(real) ? real : null;
	} catch {
		return null;
	}
}

/**
 * Sends a top-level navigation back to the Deblocker interface. A tiny page with a meta refresh is
 * used instead of a redirect: window.open() popups start on an about:blank page that Scramjet has
 * already instrumented, and a redirect would let Deblocker boot inside that instrumented window.
 */
function backToDeblocker(real) {
	const target = `${SCOPE}${real ? `?url=${encodeURIComponent(real)}` : ""}`;
	const attribute = target.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
	return new Response(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${attribute}"><title>Deblocker</title>`, {
		status: 200,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" },
	});
}

let lastRevive = 0;

async function waitForController(event) {
	if ($scramjetController.shouldRoute(event)) return true;
	// One announcement per restart, however many requests woke the worker.
	if (Date.now() - lastRevive > 2000) {
		lastRevive = Date.now();
		const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		for (const page of pages) page.postMessage({ $controller$swrevive: {} });
	}
	const started = Date.now();
	while (Date.now() - started < REVIVE_TIMEOUT_MS) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		if ($scramjetController.shouldRoute(event)) return true;
	}
	return false;
}

async function ownerIsGone(url) {
	let owner = null;
	for (const [prefix, id] of owners) if (url.pathname.startsWith(prefix)) owner = id;
	return owner !== null && !(await self.clients.get(owner));
}

function failure(request, status, message) {
	if (request.mode !== "navigate") return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>Deblocker</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d11;color:#a9afbd;font:14px/1.6 system-ui,sans-serif}p{max-width:28em;padding:20px;text-align:center}</style>
<p>${message}</p>`,
		{ status, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } },
	);
}

const SESSION_ENDED = "This page belongs to a Deblocker session that has ended. Reload Deblocker to continue.";

addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith(PROXY_PREFIX)) return;

	event.respondWith(
		(async () => {
			if (event.request.mode === "navigate" && event.request.destination === "document") return backToDeblocker(realUrlOf(url));
			if (!(await waitForController(event))) return failure(event.request, 503, SESSION_ENDED);
			if (await ownerIsGone(url)) return failure(event.request, 503, SESSION_ENDED);
			let timer;
			const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(null), ROUTE_TIMEOUT_MS)));
			const response = await Promise.race([$scramjetController.route(event), timeout]);
			clearTimeout(timer);
			return (
				response ??
				failure(event.request, 504, "No response arrived through Deblocker. The request may still have reached the site, so check before sending it again.")
			);
		})(),
	);
});
