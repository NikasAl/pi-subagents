import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Smoke tests spawn real `pi` child processes; unit tests stay fast.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		pool: "forks",
	},
});
