import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Integration tests hit the linked Supabase project.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
