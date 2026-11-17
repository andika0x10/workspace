import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "vinext/server/fetch-handler": fileURLToPath(new URL("./tests/app-stub.ts", import.meta.url)) } },
  plugins: [
    cloudflareTest({
      config: true,
      miniflare: { bindings: { APP_USERNAME: "test-owner", APP_PASSWORD: "test-password-not-for-production", AUTH_SECRET: "test-secret-at-least-32-characters-long" } },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    provide: {
      schema: readdirSync(new URL("./migrations/", import.meta.url))
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .map((name) => readFileSync(new URL("./migrations/" + name, import.meta.url), "utf8"))
        .join("\n"),
      permanentDeleteMigration: readFileSync(new URL("./migrations/0002_permanent_deletion.sql", import.meta.url), "utf8"),
    },
  },
});
