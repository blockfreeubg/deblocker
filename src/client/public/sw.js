/*
 * Deblocker service worker.
 *
 * Scramjet Controller does the real work (controller.sw.js): it forwards every request under a
 * frame's prefix to the Deblocker page that owns that frame, where Scramjet rewrites it and the
 * transport fetches it over Wisp.
 *
 * Browsers stop idle service workers. When a request wakes this worker up again, it no longer
 * knows which page owns which prefix until those pages re-register (Scramjet's "revive" message).
 * Instead of letting such requests fall through to the network (where they would 404), we ask the
 * open pages to reconnect and wait briefly before routing.
 */
importScripts("./engine/controller.sw.js");

const PROXY_PREFIX = new URL("./~/sj/", self.registration.scope).pathname;
const REVIVE_TIMEOUT_MS = 6000;

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

function sessionLost(request) {
	const isPage = request.destination === "document" || request.destination === "iframe";
	if (!isPage) return new Response("Deblocker session expired", { status: 503, headers: { "Content-Type": "text/plain" } });
	const home = self.registration.scope;
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>Session expired</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d11;color:#e9ebf2;font:14px/1.6 system-ui,sans-serif}
main{max-width:420px;padding:24px;text-align:center}a{color:#47cce8}</style>
<main><h1 style="font-size:18px">This page belongs to an old Deblocker session</h1>
<p>Reload Deblocker to continue browsing.</p><p><a href="${home}" target="_top">Open Deblocker</a></p></main>`,
		{ status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
}

addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith(PROXY_PREFIX)) return;
	event.respondWith(
		(async () => {
			if (await waitForController(event)) return $scramjetController.route(event);
			return sessionLost(event.request);
		})(),
	);
});
