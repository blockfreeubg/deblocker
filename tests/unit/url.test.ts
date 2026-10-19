import { describe, expect, it } from "vitest";
import { explainBlockedDestination, resolveInput } from "../../src/shared/url.js";

const DDG = "https://duckduckgo.com/?q=%s";
const resolve = (input: string) => resolveInput(input, DDG);

describe("resolveInput", () => {
	it.each([
		["example.com", "https://example.com/"],
		["  Example.COM  ", "https://example.com/"],
		["example.com/path?q=1#frag", "https://example.com/path?q=1#frag"],
		["example.com:8080/x", "https://example.com:8080/x"],
		["http://example.com", "http://example.com/"],
		["HTTPS://Sub.Example.co.uk/a", "https://sub.example.co.uk/a"],
		["//example.org/x", "https://example.org/x"],
		["localhost:3000", "https://localhost:3000/"],
		["1.2.3.4", "https://1.2.3.4/"],
		["192.168.1.1:8080", "https://192.168.1.1:8080/"],
		["[::1]:8080", "https://[::1]:8080/"],
		["münchen.de", "https://xn--mnchen-3ya.de/"],
		["example.com/search?q=hello world", "https://example.com/search?q=hello%20world"],
		["my_host.example.com", "https://my_host.example.com/"],
	])("treats %j as an address", (input, expected) => {
		expect(resolve(input)).toEqual({ kind: "url", url: expected });
	});

	it.each([
		"weather",
		"how to bake bread",
		"1.5",
		"3.14",
		"v2.0",
		"c++: tutorial",
		"note: groceries",
		"foo.bar baz",
		"someone@example.com",
		"what is example.com",
	])("treats %j as a search", (input) => {
		const result = resolve(input);
		expect(result.kind).toBe("search");
		if (result.kind === "search") {
			expect(result.url).toBe(`https://duckduckgo.com/?q=${encodeURIComponent(input.trim())}`);
		}
	});

	it.each(["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "about:blank", "mailto:a@b.c", "chrome://settings", "ftp://example.com"])(
		"refuses the %j scheme",
		(input) => {
			expect(resolve(input).kind).toBe("error");
		},
	);

	it("refuses broken http URLs and credentials", () => {
		expect(resolve("http://").kind).toBe("error");
		expect(resolve("https://exa mple.com").kind).toBe("error");
		expect(resolve("https://user:pass@example.com").kind).toBe("error");
	});

	it("rejects empty input", () => {
		expect(resolve("   ").kind).toBe("error");
	});

	it("recognises built-in pages", () => {
		expect(resolve("deblocker://settings")).toEqual({ kind: "internal", page: "settings" });
		expect(resolve("deblocker://")).toEqual({ kind: "internal", page: "home" });
		expect(resolve("deblocker://about/")).toEqual({ kind: "internal", page: "about" });
		expect(resolve("deblocker://nope").kind).toBe("error");
	});

	it("uses the configured search template", () => {
		const result = resolveInput("a&b", "https://search.example/?term=%s&x=1");
		expect(result).toEqual({ kind: "search", query: "a&b", url: "https://search.example/?term=a%26b&x=1" });
	});
});

describe("explainBlockedDestination", () => {
	const hints = { ports: [80, 443], privateDestinations: false };

	it("allows public destinations on allowed ports", () => {
		expect(explainBlockedDestination("https://example.com/", hints)).toBeNull();
		expect(explainBlockedDestination("http://example.com/", hints)).toBeNull();
	});

	it.each(["https://localhost/", "https://127.0.0.1/", "http://10.0.0.5/", "http://192.168.0.1/", "http://169.254.169.254/latest", "http://[::1]/", "http://printer.local/"])(
		"explains that %s is blocked",
		(url) => {
			expect(explainBlockedDestination(url, hints)).toMatch(/private network/);
		},
	);

	it("explains port restrictions", () => {
		expect(explainBlockedDestination("https://example.com:8443/", hints)).toMatch(/port/);
		expect(explainBlockedDestination("https://example.com:8443/", { ports: "any", privateDestinations: false })).toBeNull();
	});

	it("allows private addresses when the operator enabled them", () => {
		expect(explainBlockedDestination("http://127.0.0.1:80/", { ports: "any", privateDestinations: true })).toBeNull();
	});
});
