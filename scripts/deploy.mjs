import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

function deploy() {
  const pkg = JSON.parse(readFileSync("node_modules/cf/package.json", "utf8"));
  const cli = resolve("node_modules/cf", pkg.bin.cf);
  const secretNames = ["APP_USERNAME", "APP_PASSWORD", "AUTH_SECRET"];

  // Git builds have no .dev.vars. Prefer build secrets, with a local fallback.
  let localValues = {};
  if (secretNames.some((key) => process.env[key] === undefined)) {
    try {
      localValues = parseEnv(readFileSync(".dev.vars", "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const secrets = Object.fromEntries(secretNames.map((key) => [key, process.env[key] ?? localValues[key]]).filter(([, value]) => value !== undefined));
  const hasSecrets = Object.keys(secrets).length > 0;
  if (hasSecrets && (!secrets.APP_USERNAME || !secrets.APP_PASSWORD || (secrets.AUTH_SECRET?.length ?? 0) < 32)) {
    throw new Error("Isi APP_USERNAME, APP_PASSWORD, dan AUTH_SECRET (minimal 32 karakter) melalui environment build atau .dev.vars.");
  }

  const argumentsList = [cli, "deploy", "--prebuilt"];
  if (process.argv.includes("--dry-run")) argumentsList.push("--dry-run");
  let secretsFile;
  try {
    if (hasSecrets) {
      mkdirSync(".cloudflare", { recursive: true });
      const file = resolve(".cloudflare", "deploy-secrets-" + randomUUID() + ".json");
      writeFileSync(file, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
      secretsFile = file;
      argumentsList.push("--secrets-file", secretsFile);
    } else {
      console.log("Menggunakan secrets yang sudah tersimpan di Worker Cloudflare.");
    }

    // cf handles API tokens in CI, local login, and the configured account.
    const result = spawnSync(process.execPath, argumentsList, { encoding: "utf8", windowsHide: true, env: process.env, maxBuffer: 16 * 1024 * 1024 });
    const redact = (value) => Object.values(secrets).reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value ?? "");
    process.stdout.write(redact(result.stdout));
    process.stderr.write(redact(result.stderr));
    if (result.error) process.stderr.write("Deployment process could not start.\n");
    process.exitCode = result.status ?? 1;
  } finally {
    if (secretsFile) unlinkSync(secretsFile);
  }
}

try {
  deploy();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
