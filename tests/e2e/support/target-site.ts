import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny website on 127.0.0.1 used as the destination in end-to-end tests
 * (the test environment can't rely on reaching the public internet).
 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function page(title: string, body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="/icon.png"></head><body>${body}</body></html>`;
}

export interface TargetSite {
	origin: string;
	port: number;
	close(): Promise<void>;
}

export async function startTargetSite(): Promise<TargetSite> {
	const handle = async (req: http.IncomingMessage, res: http.ServerResponse, preread?: Buffer) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const html = (status: number, content: string, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
			res.end(content);
		};
		switch (url.pathname) {
			case "/":
				return html(
					200,
					page(
						"Target Home",
						`<h1 id="heading">Target home</h1>
						<a id="to-two" href="/two">Go to page two</a>
						<a id="to-redirect" href="/redirect">Redirect to page two</a>
						<a id="to-blank" href="/two" target="_blank">Open in new window</a>
						<img id="pixel" src="/icon.png" alt="">
						<p id="fetched">pending</p>
						<script>
							fetch("/api/data").then(r => r.json()).then(d => document.getElementById("fetched").textContent = d.message);
						</script>`,
					),
				);
			case "/two":
				return html(
					200,
					page(
						"Page Two",
						`<h1 id="heading">Page two</h1>
						<button id="push" onclick="history.pushState({}, '', '/two/pushed'); document.title = 'Pushed State'">push state</button>
						<form id="form" method="post" action="/echo"><input name="message" value="hello form"><button id="submit">send</button></form>`,
					),
				);
			case "/redirect":
				res.writeHead(302, { location: "/two" });
				return res.end();
			case "/api/data":
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ message: "fetched through the proxy" }));
			case "/icon.png":
				res.writeHead(200, { "content-type": "image/png" });
				return res.end(PNG);
			case "/echo": {
				let body = preread?.toString("utf8") ?? "";
				if (!preread) for await (const chunk of req) body += chunk;
				return html(200, page("Echo", `<pre id="echo">${req.method} ${body.replace(/</g, "&lt;")}</pre>`));
			}
			case "/search":
				return html(200, page(`Results for ${url.searchParams.get("q") ?? ""}`, `<p id="query">${(url.searchParams.get("q") ?? "").replace(/</g, "&lt;")}</p>`));
			case "/slow":
				await new Promise((resolve) => setTimeout(resolve, 2500));
				return html(200, page("Slow Page", `<h1 id="heading">Slow page</h1>`));
			default:
				return html(404, page("Not Found", `<h1>Not found</h1>`));
		}
	};
	const server = http.createServer((req, res) => void handle(req, res));
	// libcurl asks plain-http servers for an "h2c" upgrade. Node routes those requests to the
	// "upgrade" event (without parsing the body), so answer them here as ordinary HTTP/1.1.
	server.on("upgrade", (req, socket, head: Buffer) => {
		if (String(req.headers.upgrade).toLowerCase() === "websocket") return socket.destroy();
		const length = Number(req.headers["content-length"] ?? 0);
		let body = Buffer.from(head ?? []);
		const respond = () => {
			socket.removeAllListeners("data");
			const res = new http.ServerResponse(req);
			res.assignSocket(socket as never);
			res.shouldKeepAlive = false;
			res.on("finish", () => socket.end());
			void handle(req, res, body.subarray(0, length));
		};
		if (body.length >= length) return respond();
		socket.on("data", (chunk: Buffer) => {
			body = Buffer.concat([body, chunk]);
			if (body.length >= length) respond();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		origin: `http://127.0.0.1:${port}`,
		port,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
