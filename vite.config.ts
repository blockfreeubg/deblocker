import { defineConfig } from "vite";

// The client is built with a relative base ("./") so the same build works at the domain root
// or under any sub-path (BASE_PATH). In development the server passes the real base path instead.
export default defineConfig({
	root: "src/client",
	base: "./",
	publicDir: "public",
	build: {
		outDir: "../../dist/public",
		emptyOutDir: true,
		target: "es2022",
		assetsInlineLimit: 0,
		sourcemap: true,
	},
});
