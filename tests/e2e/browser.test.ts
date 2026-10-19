import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core";
import { chromiumPath, startApp, type RunningApp } from "./support/app.js";
import { startTargetSite, type TargetSite } from "./support/target-site.js";

const executablePath = chromiumPath();
const suite = executablePath ? describe : describe.skip;

let browser: Browser;
let target: TargetSite;

async function proxiedFrame(page: Page, path?: string): Promise<Frame> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const frame = page
			.frames()
			.find((f) => f.parentFrame() === page.mainFrame() && f.url().includes("/~/sj/") && (!path || decodeURIComponent(f.url()).includes(path)));
		if (frame) {
			try {
				await frame.waitForSelector("body", { timeout: 2000 });
				return frame;
			} catch {
				// navigating; retry
			}
		}
		await page.waitForTimeout(100);
	}
	throw new Error(`No proxied frame for ${path ?? "any page"}`);
}

async function activeFrame(page: Page): Promise<Frame> {
	const handle = await page.waitForSelector("#frames iframe.is-active", { timeout: 15_000 });
	const frame = await handle.contentFrame();
	if (!frame) throw new Error("active iframe has no frame");
	return frame;
}

async function openApp(context: BrowserContext, app: RunningApp): Promise<Page> {
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(`[${expect.getState().currentTestName}] ${error.stack || error.message}`));
	(page as Page & { errors?: string[] }).errors = errors;
	await page.goto(app.url);
	await page.waitForSelector("#statusChip[data-state=online]", { timeout: 20_000 });
	return page;
}

async function go(page: Page, input: string) {
	await page.fill("#omniboxInput", input);
	await page.press("#omniboxInput", "Enter");
}

const omnibox = (page: Page) => page.inputValue("#omniboxInput");

beforeAll(async () => {
	target = await startTargetSite();
	if (executablePath) browser = await chromium.launch({ executablePath, headless: true });
});

afterAll(async () => {
	await browser?.close();
	await target?.close();
});

suite("browsing through Scramjet", () => {
	let app: RunningApp;
	let context: BrowserContext;
	let page: Page;

	beforeAll(async () => {
		app = await startApp({
			ALLOW_PRIVATE_DESTINATIONS: "true",
			ALLOWED_PORTS: "*",
			DEFAULT_SEARCH_ENGINE: `${target.origin}/search?q=%s`,
		});
		context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		page = await openApp(context, app);
	});

	afterAll(async () => {
		await context?.close();
		await app?.stop();
	});

	it("renders the home page with branding and quick links", async () => {
		expect(await page.title()).toBe("Deblocker");
		expect(await page.getAttribute("#wordmark", "aria-label")).toBe("deblocker");
		expect(await page.locator(".quicklink:not(.is-edit)").count()).toBe(6);
		expect(await page.isVisible("#view-home")).toBe(true);
	});

	it("opens an address typed on the home page and loads it through the proxy", async () => {
		await page.fill("#homeInput", target.origin);
		await page.click(".search-go");
		const frame = await proxiedFrame(page);
		await frame.waitForSelector("#heading");
		expect(await frame.textContent("#heading")).toBe("Target home");
		await expect.poll(() => frame.textContent("#fetched")).toBe("fetched through the proxy");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/`);
		await expect.poll(() => page.textContent(".tab.is-active .tab-title")).toBe("Target Home");
		expect(await page.getAttribute("#omniboxIcon", "data-kind")).toBe("insecure");
		expect(await page.isHidden("#loader")).toBe(true);
	});

	it("tries https for bare hosts and offers plain http when that fails", async () => {
		await go(page, `127.0.0.1:${target.port}/two`);
		await page.waitForSelector("#pageError:not([hidden])", { timeout: 20_000 });
		expect(await omnibox(page)).toBe(`https://127.0.0.1:${target.port}/two`);
		await page.locator("#pageErrorActions button", { hasText: "try http://" }).click();
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two`);
		const frame = await activeFrame(page);
		await frame.waitForSelector("text=Page two");
		expect(await page.isHidden("#pageError")).toBe(true);
		await page.click("#backBtn");
		await page.click("#backBtn");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/`);
	});

	it("follows links, tracks the URL and supports back and forward", async () => {
		let frame = await activeFrame(page);
		await frame.click("#to-two");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two`);
		frame = await activeFrame(page);
		await frame.waitForSelector("text=Page two");
		expect(await page.isEnabled("#backBtn")).toBe(true);

		await page.click("#backBtn");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/`);
		frame = await activeFrame(page);
		await frame.waitForSelector("text=Target home");
		expect(await page.isEnabled("#forwardBtn")).toBe(true);

		await page.click("#forwardBtn");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two`);
	});

	it("follows HTTP redirects", async () => {
		await go(page, `${target.origin}/redirect`);
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two`);
		const frame = await activeFrame(page);
		await frame.waitForSelector("text=Page two");
	});

	it("tracks history.pushState and title changes", async () => {
		const frame = await activeFrame(page);
		await frame.click("#push");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two/pushed`);
		await expect.poll(() => page.textContent(".tab.is-active .tab-title")).toBe("Pushed State");
	});

	it("submits forms with their request body", async () => {
		await go(page, `${target.origin}/two`);
		let frame = await activeFrame(page);
		await frame.waitForSelector("#submit");
		await frame.click("#submit");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/echo`);
		frame = await activeFrame(page);
		await expect.poll(() => frame.textContent("#echo").catch(() => "")).toBe("POST message=hello+form");
	});

	it("sends searches to the configured search engine", async () => {
		await go(page, "hello world");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/search?q=hello%20world`);
		const frame = await activeFrame(page);
		await expect.poll(() => frame.textContent("#query").catch(() => "")).toBe("hello world");
	});

	it("shows a clear error when a site can't be reached", async () => {
		await go(page, "http://127.0.0.1:9/");
		await page.waitForSelector("#pageError:not([hidden])", { timeout: 20_000 });
		expect(await page.textContent("#pageErrorTitle")).toBe("This site can't be reached");
		expect(await page.isVisible("#frames iframe.is-active")).toBe(false);
		expect(await page.textContent("#pageErrorUrl")).toBe("http://127.0.0.1:9/");
		expect(await page.locator("#pageErrorActions button", { hasText: "try again" }).count()).toBe(1);
		await page.locator("#pageErrorActions button", { hasText: "go back" }).click();
		await page.waitForSelector("#pageError", { state: "hidden" });
	});

	it("refuses unsupported schemes with a message instead of navigating", async () => {
		await go(page, "javascript:alert(1)");
		await page.waitForSelector(".toast[data-tone=error]");
		expect(await page.textContent(".toast[data-tone=error]")).toContain("only opens http and https");
	});

	it("returns home and back without reloading the page", async () => {
		await go(page, `${target.origin}/two`);
		let frame = await activeFrame(page);
		await frame.waitForSelector("text=Page two");
		await frame.evaluate(() => ((window as unknown as { marker: number }).marker = 42));
		await page.click("#homeBtn");
		expect(await page.isVisible("#view-home")).toBe(true);
		expect(await omnibox(page)).toBe("");
		await page.click("#backBtn");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two`);
		frame = await activeFrame(page);
		expect(await frame.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(42);
	});

	it("manages tabs", async () => {
		const before = await page.locator(".tab").count();
		await page.click("#newTab");
		expect(await page.locator(".tab").count()).toBe(before + 1);
		expect(await page.isVisible("#view-home")).toBe(true);
		await page.keyboard.press("Alt+W");
		await expect.poll(() => page.locator(".tab").count()).toBe(before);
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two`);
	});

	it("opens links that target a new window in a new Deblocker window", async () => {
		await go(page, `${target.origin}/`);
		const frame = await activeFrame(page);
		await frame.waitForSelector("#to-blank");
		const [popup] = await Promise.all([context.waitForEvent("page"), frame.click("#to-blank")]);
		await popup.waitForLoadState();
		await expect.poll(() => popup.url()).toContain(app.url);
		await popup.waitForSelector("#statusChip[data-state=online]", { timeout: 20_000 });
		await expect.poll(() => popup.inputValue("#omniboxInput")).toBe(`${target.origin}/two`);
		await popup.close();
	});

	it("opens window.open() popups as a Deblocker window with just that page", async () => {
		await go(page, `${target.origin}/`);
		const frame = await activeFrame(page);
		await frame.waitForSelector("#open-popup");
		const [popup] = await Promise.all([context.waitForEvent("page"), frame.click("#open-popup")]);
		await popup.waitForLoadState();
		await popup.waitForSelector("#statusChip[data-state=online]", { timeout: 20_000 });
		await expect.poll(() => popup.inputValue("#omniboxInput")).toBe(`${target.origin}/two`);
		const popupFrame = await activeFrame(popup);
		await popupFrame.waitForSelector("text=Page two");
		// The popup inherits the opener's sessionStorage, but must not duplicate its tabs.
		expect(await popup.locator(".tab").count()).toBe(1);
		await popup.close();
	});

	it("keeps forms that target the top window inside the tab", async () => {
		await go(page, `${target.origin}/`);
		const frame = await activeFrame(page);
		await frame.waitForSelector("#top-submit");
		await page.evaluate(() => ((window as unknown as { shellMarker: number }).shellMarker = 7));
		const tabs = await page.locator(".tab").count();
		await frame.click("#top-submit");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/search?q=from+form`);
		const results = await activeFrame(page);
		await expect.poll(() => results.textContent("#query").catch(() => "")).toBe("from form");
		// The Deblocker interface itself was not navigated or reloaded.
		expect(await page.evaluate(() => (window as unknown as { shellMarker?: number }).shellMarker)).toBe(7);
		expect(await page.locator(".tab").count()).toBe(tabs);
	});

	it("closes a page's WebSockets when the page goes away", async () => {
		await go(page, `${target.origin}/ws`);
		const frame = await activeFrame(page);
		await expect.poll(() => frame.textContent("#ws").catch(() => ""), { timeout: 15_000 }).toBe("echo:hi");
		expect(target.openSockets()).toBe(1);
		await go(page, `${target.origin}/two`);
		await expect.poll(() => target.openSockets(), { timeout: 10_000 }).toBe(0);
	});

	it("leaves keys that edit text alone, and only swallows shortcuts it acts on", async () => {
		type Key = { key: string; code: string; altKey?: boolean; shiftKey?: boolean };
		const prevented = (selector: string | null, init: Key): Promise<boolean> =>
			page.evaluate(
				(args: { selector: string | null; init: Key }) => {
					const target = args.selector ? document.querySelector(args.selector)! : document.body;
					const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...args.init });
					target.dispatchEvent(event);
					return event.defaultPrevented;
				},
				{ selector, init },
			);
		const tabs = await page.locator(".tab").count();
		// Alt/Option+arrows move by word in text fields; with Shift they select.
		expect(await prevented("#omniboxInput", { key: "ArrowLeft", code: "ArrowLeft", altKey: true })).toBe(false);
		expect(await prevented(null, { key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true })).toBe(false);
		// A layout where the W key types "z" (AZERTY): Alt+Z must not close the tab.
		expect(await prevented(null, { key: "z", code: "KeyW", altKey: true })).toBe(false);
		// Alt+9 with fewer than nine tabs does nothing, so the key isn't taken.
		expect(await prevented(null, { key: "9", code: "Digit9", altKey: true })).toBe(false);
		expect(await page.locator(".tab").count()).toBe(tabs);
		// Alt+1 acts, so it is taken.
		expect(await prevented(null, { key: "1", code: "Digit1", altKey: true })).toBe(true);
	});

	it("keeps keyboard focus on settings controls while changing them", async () => {
		await page.click('.rail-btn[data-nav="settings"]');
		await page.click('.settings-nav-btn:has-text("appearance")');
		expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("appearance");
		const toggle = page.locator('[aria-label="Show background art"]');
		const before = await toggle.getAttribute("aria-checked");
		await toggle.focus();
		await page.keyboard.press("Space");
		await expect.poll(() => toggle.getAttribute("aria-checked")).not.toBe(before);
		await page.keyboard.press("Space");
		await expect.poll(() => toggle.getAttribute("aria-checked")).toBe(before);
		expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Show background art");
	});

	it("remembers settings and open tabs across reloads", async () => {
		await page.click('.rail-btn[data-nav="settings"]');
		await page.click('.settings-nav-btn:has-text("appearance")');
		await page.click('.swatch:has-text("ember")');
		expect(await page.getAttribute("html", "data-theme")).toBe("ember");
		const tabs = await page.locator(".tab").count();
		await page.reload();
		await page.waitForSelector("#statusChip[data-state=online]", { timeout: 20_000 });
		expect(await page.getAttribute("html", "data-theme")).toBe("ember");
		expect(await page.locator(".tab").count()).toBe(tabs);
	});

	it("loads quick links edited in settings", async () => {
		await page.click('.rail-btn[data-nav="settings"]');
		await page.click('.settings-nav-btn:has-text("quick links")');
		await page.fill('input[aria-label="New link title"]', "Local target");
		await page.fill('input[aria-label="New link address"]', `${target.origin}/two`);
		await page.click('.link-row button:has-text("add")');
		await page.click('.rail-btn[data-nav="home"]');
		await page.click('.quicklink:has-text("Local target")');
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two`);
	});

	it("keeps working after the browser stops the idle service worker", async () => {
		await go(page, `${target.origin}/`);
		let frame = await activeFrame(page);
		await frame.waitForSelector("#to-two");
		// Only stop it once it is idle: a worker stopped mid-request fails that request, as in any browser.
		await expect.poll(() => frame.textContent("#fetched").catch(() => "")).toBe("fetched through the proxy");
		const cdp = await context.newCDPSession(page);
		await cdp.send("ServiceWorker.enable");
		await cdp.send("ServiceWorker.stopAllWorkers");
		await page.waitForTimeout(300);
		frame = await activeFrame(page);
		await frame.click("#to-two");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two`);
		frame = await activeFrame(page);
		await frame.waitForSelector("text=Page two");
		await cdp.detach();
	});

	it("sends proxied URLs opened directly back into the Deblocker interface", async () => {
		const frame = await activeFrame(page);
		const proxiedUrl = frame.url();
		const other = await context.newPage();
		await other.goto(proxiedUrl);
		await other.waitForSelector("#statusChip[data-state=online]", { timeout: 20_000 });
		await expect.poll(() => other.inputValue("#omniboxInput")).toBe(`${target.origin}/two`);
		await other.close();
	});

	it("handles Deblocker shortcuts while a proxied page has focus", async () => {
		// A fresh address, and wait for it to finish loading, so the keys go to the new document.
		await go(page, `${target.origin}/two?keys`);
		await page.waitForSelector("#reloadBtn:not(.is-loading)");
		const frame = await activeFrame(page);
		await frame.waitForSelector("#push");
		await frame.focus("input[name=message]");
		const tabs = await page.locator(".tab").count();
		await page.keyboard.press("Alt+T");
		await expect.poll(() => page.locator(".tab").count()).toBe(tabs + 1);
		await page.keyboard.press("Alt+W");
		await expect.poll(() => page.locator(".tab").count()).toBe(tabs);
	});

	it("shows the page in full screen", async () => {
		await page.click("#fullscreenBtn");
		await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName ?? null)).toBe("IFRAME");
		await page.evaluate(() => document.exitFullscreen());
	});

	it("keeps proxied cookies until site data is cleared", async () => {
		await go(page, `${target.origin}/cookie/set`);
		let frame = await activeFrame(page);
		await frame.waitForSelector("#cookie");
		await go(page, `${target.origin}/cookie/show`);
		frame = await activeFrame(page);
		await expect.poll(() => frame.textContent("#cookie").catch(() => "")).toContain("flavour=oatmeal");

		page.once("dialog", (dialog) => void dialog.accept());
		await page.click('.rail-btn[data-nav="settings"]');
		await page.click('.settings-nav-btn:has-text("privacy")');
		await page.click('button:has-text("clear data")');
		await page.waitForSelector('.toast:has-text("Site data cleared")');
		expect(await page.locator(".tab").count()).toBe(1);

		await go(page, `${target.origin}/cookie/show`);
		frame = await activeFrame(page);
		await expect.poll(() => frame.textContent("#cookie").catch(() => "")).toBe("none");
	});

	it("did not throw uncaught errors in the Deblocker page", () => {
		expect((page as Page & { errors?: string[] }).errors ?? []).toEqual([]);
	});
});

suite("browser back button", () => {
	let app: RunningApp;
	let context: BrowserContext;

	beforeAll(async () => {
		app = await startApp({ ALLOW_PRIVATE_DESTINATIONS: "true", ALLOWED_PORTS: "*" });
		context = await browser.newContext();
	});

	afterAll(async () => {
		await context?.close();
		await app?.stop();
	});

	it("goes back in the current tab instead of leaving Deblocker", async () => {
		const page = await openApp(context, app);
		await page.click("#omniboxInput");
		await go(page, `${target.origin}/two`);
		const frame = await activeFrame(page);
		await frame.waitForSelector("text=Page two");
		await expect.poll(() => page.evaluate(() => (history.state as { dbk?: string } | null)?.dbk)).toBe("top");

		await page.evaluate(() => history.back());
		await page.waitForSelector("#view-home", { state: "visible" });
		expect(page.url()).toBe(app.url);
		await expect.poll(() => page.evaluate(() => (history.state as { dbk?: string } | null)?.dbk)).toBe("top");
		await page.click("#forwardBtn");
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two`);
	});
});

suite("default policy", () => {
	let app: RunningApp;
	let context: BrowserContext;

	beforeAll(async () => {
		app = await startApp({});
		context = await browser.newContext();
	});

	afterAll(async () => {
		await context?.close();
		await app?.stop();
	});

	it("explains that local network addresses are blocked", async () => {
		const page = await openApp(context, app);
		await go(page, `${target.origin}/`);
		await page.waitForSelector("#pageError:not([hidden])");
		expect(await page.textContent("#pageErrorTitle")).toBe("Blocked by this server");
		expect(await page.textContent("#pageErrorText")).toMatch(/private network/);
		expect(await page.locator("#frames iframe").count()).toBe(0);
	});
});

suite("server blocklist", () => {
	let app: RunningApp;
	let context: BrowserContext;

	beforeAll(async () => {
		app = await startApp({ ALLOW_PRIVATE_DESTINATIONS: "true", ALLOWED_PORTS: "*", DESTINATION_BLOCKLIST: "127.0.0.1" });
		context = await browser.newContext();
	});

	afterAll(async () => {
		await context?.close();
		await app?.stop();
	});

	it("explains destinations refused by the server's policy", async () => {
		const page = await openApp(context, app);
		await go(page, `${target.origin}/`);
		await page.waitForSelector("#pageError:not([hidden])", { timeout: 20_000 });
		await expect.poll(() => page.textContent("#pageErrorTitle")).toBe("Blocked by this server");
	});
});

suite("sub-path deployment", () => {
	let app: RunningApp;
	let context: BrowserContext;

	beforeAll(async () => {
		app = await startApp({ BASE_PATH: "/apps/deblocker", ALLOW_PRIVATE_DESTINATIONS: "true", ALLOWED_PORTS: "*" });
		context = await browser.newContext();
	});

	afterAll(async () => {
		await context?.close();
		await app?.stop();
	});

	it("registers the service worker and proxies pages under the sub-path", async () => {
		const page = await openApp(context, app);
		expect(app.url).toMatch(/\/apps\/deblocker\/$/);
		await go(page, `${target.origin}/`);
		const frame = await activeFrame(page);
		await frame.waitForSelector("#heading");
		expect(frame.url()).toContain("/apps/deblocker/~/sj/");
		await expect.poll(() => frame.textContent("#fetched")).toBe("fetched through the proxy");
		const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope);
		expect(scope).toBe(app.url);
	});
});

suite("access key", () => {
	let app: RunningApp;
	let context: BrowserContext;

	beforeAll(async () => {
		app = await startApp({ ACCESS_KEY: "letmein-please", ALLOW_PRIVATE_DESTINATIONS: "true", ALLOWED_PORTS: "*" });
		context = await browser.newContext();
	});

	afterAll(async () => {
		await context?.close();
		await app?.stop();
	});

	it("asks for the key, then allows browsing", async () => {
		const page = await context.newPage();
		await page.goto(app.url);
		await page.waitForSelector("#unlockForm:not([hidden])");
		expect(await page.isVisible("#homeSearch")).toBe(false);
		await page.fill("#unlockInput", "wrong-key-123");
		await page.click('#unlockForm button[type="submit"]');
		await page.waitForSelector("#unlockError:not([hidden])");
		await page.fill("#unlockInput", "letmein-please");
		await page.click('#unlockForm button[type="submit"]');
		await page.waitForSelector("#homeSearch:not([hidden])");
		await page.waitForSelector("#statusChip[data-state=online]", { timeout: 20_000 });
		await go(page, `${target.origin}/`);
		const frame = await activeFrame(page);
		await frame.waitForSelector("#heading");
	});

	it("asks for the key again when the session ends, then returns to the page", async () => {
		const page = context.pages()[0]!;
		// Without SESSION_SECRET, a restart invalidates every session.
		const port = new URL(app.url).port;
		await app.stop();
		app = await startApp({ ACCESS_KEY: "letmein-please", ALLOW_PRIVATE_DESTINATIONS: "true", ALLOWED_PORTS: "*", PORT: port });

		await go(page, `${target.origin}/two`);
		await page.waitForSelector('#pageError:not([hidden]):has-text("Access key needed")', { timeout: 20_000 });
		expect(await page.textContent("#statusText")).toBe("locked");
		await page.click('#pageError button:has-text("enter access key")');
		await page.waitForSelector("#unlockForm:not([hidden])");
		await page.fill("#unlockInput", "letmein-please");
		await page.click('#unlockForm button[type="submit"]');
		await expect.poll(() => omnibox(page)).toBe(`${target.origin}/two`);
		const frame = await activeFrame(page);
		await frame.waitForSelector("text=Page two");
	});
});
