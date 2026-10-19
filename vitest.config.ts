import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
					environment: "node",
				},
			},
			{
				test: {
					name: "e2e",
					include: ["tests/e2e/**/*.test.ts"],
					environment: "node",
					testTimeout: 90_000,
					hookTimeout: 120_000,
					fileParallelism: false,
				},
			},
		],
	},
});
