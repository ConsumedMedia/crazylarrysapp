import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // `server-only` throws when imported outside an RSC; stub it for tests.
      {
        find: "server-only",
        replacement: fileURLToPath(
          new URL("./test/stubs/server-only.ts", import.meta.url),
        ),
      },
      // Scoped so it doesn't swallow "@next/env", "@supabase/*", etc.
      { find: /^@\/(.*)$/, replacement: `${root}$1` },
    ],
  },
  // tsconfig says jsx: "preserve" (Next compiles it); tests need the same
  // automatic runtime Next uses, so .tsx renders without importing React.
  esbuild: { jsx: "automatic" },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Integration tests hit the linked Supabase project.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
