import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const fixture = "APP_USERNAME=test-owner\nAPP_PASSWORD=test-password-not-for-production\nAUTH_SECRET=test-secret-at-least-32-characters-long\n";
if (!existsSync(".dev.vars.test")) writeFileSync(".dev.vars.test", fixture);
const pkg = JSON.parse(readFileSync("node_modules/cf/package.json", "utf8"));
const cli = resolve("node_modules/cf", pkg.bin.cf);
const result = spawnSync(
  process.execPath,
  [cli, "d1", "migrations", "apply", "00000000-0000-4000-8000-000000000001", "--local", "--mode", "test", "--persist-to", ".cloudflare/e2e-state"],
  { stdio: "inherit", windowsHide: true }
);
process.exit(result.status ?? 1);
