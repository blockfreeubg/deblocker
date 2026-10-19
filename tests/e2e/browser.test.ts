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
	page.on("pageerror", (error) => errors.push(error.message));
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
		await expect.poll(() => page.textContent(".tab[aria-selected=true] .tab-title")).toBe("Target Home");
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
		await expect.poll(() => page.textContent(".tab[aria-selected=true] .tab-title")).toBe("Pushed State");
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
		expect(await page.textContent("#pageErrorTitle")).toMatch(/can't be reached|couldn't be loaded|took too long/);
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

	it("did not throw uncaught errors in the Deblocker page", () => {
		expect((page as Page & { errors?: string[] }).errors ?? []).toEqual([]);
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
});
