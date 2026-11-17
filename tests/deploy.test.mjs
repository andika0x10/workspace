import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const secretNames = ["APP_USERNAME", "APP_PASSWORD", "AUTH_SECRET"];
const credentials = { APP_USERNAME: "fixture-owner", APP_PASSWORD: "fixture-password-$literal", AUTH_SECRET: "fixture-auth-secret-at-least-32-characters" };

function fixture(t, { local, environment = {}, cliExitCode = 0, echoSecrets = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "workspace-deploy-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cliDirectory = join(directory, "node_modules/cf");
  mkdirSync(cliDirectory, { recursive: true });
  copyFileSync(new URL("../scripts/deploy.mjs", import.meta.url), join(directory, "deploy.mjs"));
  writeFileSync(join(cliDirectory, "package.json"), JSON.stringify({ type: "module", bin: { cf: "cli.mjs" } }));
  writeFileSync(join(cliDirectory, "cli.mjs"), `
    import { readFileSync, writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    const index = args.indexOf("--secrets-file");
    const secrets = index < 0 ? null : JSON.parse(readFileSync(args[index + 1], "utf8"));
    writeFileSync("invocation.json", JSON.stringify({ args, secrets, token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID }));
    if (${echoSecrets} && secrets) {
      console.log(Object.values(secrets).join("\\n"));
      console.error(Object.values(secrets).join("\\n"));
    }
    process.exitCode = ${cliExitCode};
  `);
  if (local) writeFileSync(join(directory, ".dev.vars"), Object.entries(local).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n"));
  const env = { ...process.env, CI: "true" };
  for (const key of [...secretNames, "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  Object.assign(env, environment);
  return {
    directory,
    run: (...args) => spawnSync(process.execPath, [join(directory, "deploy.mjs"), ...args], { cwd: directory, env, encoding: "utf8", windowsHide: true }),
    invocation: () => JSON.parse(readFileSync(join(directory, "invocation.json"), "utf8")),
    temporarySecrets: () => existsSync(join(directory, ".cloudflare")) ? readdirSync(join(directory, ".cloudflare")) : [],
  };
}

test("a Git checkout without .dev.vars deploys using existing Worker secrets", (t) => {
  const project = fixture(t);
  const result = project.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(project.invocation().args, ["deploy", "--prebuilt"]);
  assert.equal(project.invocation().secrets, null);
  assert.deepEqual(project.temporarySecrets(), []);
});

test("CI credentials and account are passed through without a fixed login profile", (t) => {
  const project = fixture(t, { environment: { ...credentials, CLOUDFLARE_API_TOKEN: "fixture-token", CLOUDFLARE_ACCOUNT_ID: "fixture-account" } });
  const result = project.run();
  assert.equal(result.status, 0, result.stderr);
  const invocation = project.invocation();
  assert.equal(invocation.token, "fixture-token");
  assert.equal(invocation.account, "fixture-account");
  assert.equal(invocation.args.includes("--profile"), false);
  assert.deepEqual(invocation.secrets, credentials);
  assert.deepEqual(project.temporarySecrets(), []);
});

test("local deployment still accepts .dev.vars", (t) => {
  const project = fixture(t, { local: credentials });
  const result = project.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(project.invocation().secrets, credentials);
});

test("environment secrets take priority over local values", (t) => {
  const project = fixture(t, { local: credentials, environment: { APP_PASSWORD: "environment-password" } });
  const result = project.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(project.invocation().secrets, { ...credentials, APP_PASSWORD: "environment-password" });
});

test("a complete environment does not read the local secrets path", (t) => {
  const project = fixture(t, { environment: credentials });
  mkdirSync(join(project.directory, ".dev.vars"));
  const result = project.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(project.invocation().secrets, credentials);
});

for (const [name, environment] of [
  ["incomplete secrets", { APP_USERNAME: "fixture-owner" }],
  ["a short authentication secret", { ...credentials, AUTH_SECRET: "too-short" }],
  ["an explicitly empty environment override", { APP_PASSWORD: "" }],
]) {
  test(`rejects ${name} before starting deployment`, (t) => {
    const project = fixture(t, { local: name.includes("override") ? credentials : undefined, environment });
    const result = project.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /environment build atau \.dev\.vars/);
    assert.equal(existsSync(join(project.directory, "invocation.json")), false);
    assert.deepEqual(project.temporarySecrets(), []);
  });
}

test("dry-run works without local secrets or a login preflight", (t) => {
  const project = fixture(t);
  const result = project.run("--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(project.invocation().args, ["deploy", "--prebuilt", "--dry-run"]);
});

test("a failed deployment preserves its exit code, redacts logs, and removes temporary secrets", (t) => {
  const project = fixture(t, { environment: credentials, cliExitCode: 7, echoSecrets: true });
  const result = project.run();
  assert.equal(result.status, 7);
  for (const secret of Object.values(credentials)) {
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(project.invocation().args.some((argument) => argument.includes(secret)), false);
  }
  assert.match(result.stdout, /\[redacted\]/);
  assert.match(result.stderr, /\[redacted\]/);
  assert.deepEqual(project.temporarySecrets(), []);
});

test("unreadable local secrets fail instead of silently deploying", (t) => {
  const project = fixture(t);
  mkdirSync(join(project.directory, ".dev.vars"));
  const result = project.run();
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(project.directory, "invocation.json")), false);
});
