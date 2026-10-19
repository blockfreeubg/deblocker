/*
 * Deblocker service worker.
 *
 * Scramjet Controller does the real work (controller.sw.js): it forwards every request under a
 * frame's prefix to the Deblocker page that owns that frame, where Scramjet rewrites it and the
 * transport fetches it over Wisp. This file adds the robustness the stock example lacks:
 *
 *  - Browsers stop idle service workers. A request that wakes this worker arrives before the open
 *    pages have re-registered their prefixes, so we ask them to reconnect and wait briefly instead of
 *    letting the request fall through to the network (where it would 404).
 *  - A proxied URL opened as a top-level page (a link opened in a new tab, window.open, a copied
 *    link, a page from an old session) is sent back into the Deblocker interface.
 *  - Requests for a prefix whose page has gone away (Deblocker was reloaded) would wait forever;
 *    they time out instead.
 */
importScripts("./engine/controller.sw.js");

const SCOPE = new URL(self.registration.scope).pathname;
const PROXY_PREFIX = `${SCOPE}~/sj/`;
const REVIVE_TIMEOUT_MS = 6000;
// Time to the first response byte. Pages get a short limit; other requests may be long-polls.
const NAVIGATION_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 180000;

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

function backToDeblocker(real) {
	return Response.redirect(`${SCOPE}${real ? `?url=${encodeURIComponent(real)}` : ""}`, 302);
}

async function waitForController(event) {
	if ($scramjetController.shouldRoute(event)) return true;
	const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	for (const page of pages) page.postMessage({ $controller$swrevive: {} });
	const started = Date.now();
	while (Date.now() - started < REVIVE_TIMEOUT_MS) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		if ($scramjetController.shouldRoute(event)) return true;
	}
	return false;
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

addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith(PROXY_PREFIX)) return;

	event.respondWith(
		(async () => {
			if (event.request.mode === "navigate" && event.request.destination === "document") return backToDeblocker(realUrlOf(url));
			if (!(await waitForController(event))) return failure(event.request, 503, "This page belongs to a Deblocker session that has ended. Reload Deblocker to continue.");
			let timer;
			const limit = event.request.mode === "navigate" ? NAVIGATION_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
			const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(null), limit)));
			const response = await Promise.race([$scramjetController.route(event), timeout]);
			clearTimeout(timer);
			return response ?? failure(event.request, 504, "The page took too long to respond through Deblocker. Try reloading it.");
		})(),
	);
});
