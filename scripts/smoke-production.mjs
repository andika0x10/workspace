import { chromium, request, expect, devices } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";
const baseURL = process.argv[2];
if (!baseURL || new URL(baseURL).protocol !== "https:") throw new Error("Provide the deployed HTTPS origin.");
const credentials = parseEnv(readFileSync(".dev.vars", "utf8"));
const values = { username: credentials.APP_USERNAME, password: credentials.APP_PASSWORD };
const origin = new URL(baseURL).origin;
let browser, api, secondApi, boardId;
try {
  api = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  assert.equal((await api.get("/api/boards")).status(), 401, "Anonymous requests must be rejected.");
  assert.equal((await api.post("/api/auth/login", { data: values })).status(), 200, "Production login failed.");
  const original = await (await api.get("/api/boards")).json();
  boardId = crypto.randomUUID();
  const boardName = "Pemeriksaan rilis " + boardId.slice(0, 6);
  assert.equal((await api.post("/api/boards", { data: { boardId, name: boardName, mutationId: crypto.randomUUID() } })).status(), 200);
  secondApi = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  assert.equal((await secondApi.post("/api/auth/login", { data: values })).status(), 200);
  browser = await chromium.launch();
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: await api.storageState() });
  const mobileContext = await browser.newContext({ ...devices["Pixel 7"], storageState: await secondApi.storageState() });
  const desktop = await desktopContext.newPage(),
    mobile = await mobileContext.newPage();
  const errors = [];
  desktop.on("pageerror", (error) => errors.push(error.message));
  mobile.on("pageerror", (error) => errors.push(error.message));
  for (const page of [desktop, mobile]) {
    await page.goto(origin);
    await page.getByRole("button", { name: "Pilih board", exact: true }).click();
    await page.getByRole("button", { name: boardName, exact: true }).click();
    await expect(page.getByRole("button", { name: "Pilih board", exact: true })).toContainText(boardName);
    await expect(page.getByRole("button", { name: "Tambahkan kartu", exact: true })).toBeEnabled();
  }
  const id = crypto.randomUUID();
  const mutate = async (data, mutationId = crypto.randomUUID()) => {
    const response = await api.post("/api/boards/" + boardId + "/mutations", { data: { ...data, mutationId } });
    assert.equal(response.status(), 200, "Production mutation failed.");
    return response.json();
  };
  const create = { kind: "create", id, cardType: "note", x: 65, y: 200 };
  const createMutationId = crypto.randomUUID();
  await mutate(create, createMutationId);
  await mutate({
    kind: "content",
    id,
    baseVersion: 0,
    title: "Rilis tersinkron",
    description: "",
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Ide tersimpan. Langkah berikutnya siap." }] }] },
  });
  for (const page of [desktop, mobile]) await expect(page.getByRole("heading", { name: "Rilis tersinkron", exact: true })).toBeVisible({ timeout: 20000 });
  await mobile.reload();
  await expect(mobile.getByRole("heading", { name: "Rilis tersinkron", exact: true })).toBeVisible({ timeout: 20000 });
  await expect(mobile.getByRole("button", { name: "Tambahkan kartu", exact: true })).toBeEnabled({ timeout: 20000 });
  mkdirSync(".cloudflare/qa", { recursive: true });
  await desktop.screenshot({ path: ".cloudflare/qa/production-desktop.png", fullPage: true });
  await mobile.screenshot({ path: ".cloudflare/qa/production-mobile.png", fullPage: true });
  await mutate({ kind: "delete", id });
  for (const page of [desktop, mobile]) await expect(page.getByRole("heading", { name: "Rilis tersinkron", exact: true })).toHaveCount(0);
  assert.deepEqual((await (await api.get("/api/boards/" + boardId)).json()).cards, []);
  assert.equal((await api.post("/api/boards/" + boardId + "/mutations", { data: { ...create, mutationId: createMutationId } })).status(), 410);
  assert.equal((await api.post("/api/boards/" + boardId + "/mutations", { data: { kind: "restore", id, mutationId: crypto.randomUUID() } })).status(), 400);
  const taskId = crypto.randomUUID();
  await mutate({ kind: "create", id: taskId, cardType: "task", x: 65, y: 200 });
  await mutate({
    kind: "content",
    id: taskId,
    baseVersion: 0,
    title: "Task pemeriksaan hapus",
    description: "Ikut terhapus bersama board.",
    doc: { type: "doc", content: [{ type: "paragraph" }] },
  });
  for (const page of [desktop, mobile]) await expect(page.getByRole("heading", { name: "Task pemeriksaan hapus", exact: true })).toBeVisible();
  await expect(mobile.locator(".mobile-card")).toHaveCount(1);
  const beforeDrag = (await (await api.get("/api/boards/" + boardId)).json()).cards.find((card) => card.id === taskId);
  const camera = await mobile.locator(".react-flow__viewport").getAttribute("style");
  const body = await mobile.locator(".mobile-card .card-content").boundingBox();
  const touch = await mobileContext.newCDPSession(mobile);
  const point = (step) => [{ id: 1, x: body.x + body.width / 2 + (25 * step) / 12, y: body.y + 35 + (40 * step) / 12, radiusX: 7, radiusY: 7, force: 1 }];
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(0) });
  for (let step = 1; step <= 12; step++) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(step) });
    await mobile.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await (await api.get("/api/boards/" + boardId)).json()).cards.find((card) => card.id === taskId).x).not.toBe(beforeDrag.x);
  const dragged = (await (await api.get("/api/boards/" + boardId)).json()).cards.find((card) => card.id === taskId);
  assert.equal(await mobile.locator(".react-flow__viewport").getAttribute("style"), camera);
  await expect(mobile.locator(".card-editor")).toHaveCount(0);
  await mobile.reload();
  await expect(mobile.getByRole("heading", { name: "Task pemeriksaan hapus", exact: true })).toBeVisible();
  const persisted = (await (await api.get("/api/boards/" + boardId)).json()).cards.find((card) => card.id === taskId);
  assert.equal(persisted.x, dragged.x);
  assert.equal(persisted.y, dragged.y);
  for (const [device, page] of [
    ["desktop", desktop],
    ["mobile", mobile],
  ]) {
    await page.getByRole("button", { name: "Edit Task pemeriksaan hapus", exact: true }).click();
    const description = page.getByRole("textbox", { name: "Deskripsi task", exact: true });
    await expect(description).toContainText("Ikut terhapus bersama board.");
    assert.equal(await description.evaluate((element) => getComputedStyle(element).color), "rgb(22, 22, 22)");
    await expect(page.locator(".editor-close")).toHaveCount(0);
    await expect(page.locator(".with-editor-close")).toHaveCount(0);
    const toolbar = page.getByRole("toolbar", { name: "Format tulisan", exact: true });
    if (device === "desktop") {
      await description.hover();
      await expect(toolbar).toBeVisible();
    }
    await description.press("ControlOrMeta+A");
    await expect(toolbar).toBeVisible();
    if (device === "desktop") await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
    else {
      await expect(description.locator("strong")).toBeVisible();
      await toolbar.getByRole("button", { name: "Italic", exact: true }).click();
    }
    await description.press("Escape");
    await expect(toolbar).not.toBeVisible();
    await page.getByLabel("Judul task", { exact: true }).click();
    await page.screenshot({ path: ".cloudflare/qa/task-editor-" + device + ".png", fullPage: true });
    await page.getByRole("button", { name: "Selesai", exact: true }).click();
    await expect(description).not.toBeVisible();
    await page.reload();
    await expect(page.locator(".task-preview strong")).toHaveText("Ikut terhapus bersama board.");
    assert.equal(await page.locator(".task-preview").evaluate((element) => getComputedStyle(element).color), "rgb(22, 22, 22)");
  }
  await desktop.getByRole("button", { name: "Pilih board", exact: true }).click();
  await desktop.getByRole("button", { name: "Hapus board", exact: true }).click();
  await expect(desktop.getByRole("dialog")).toContainText("akan dihapus permanen");
  await expect(desktop.getByRole("dialog")).not.toContainText("disembunyikan");
  await desktop.screenshot({ path: ".cloudflare/qa/delete-board-confirmation.png", fullPage: true });
  await desktop.getByRole("dialog").getByRole("button", { name: "Hapus board", exact: true }).click();
  await expect.poll(async () => (await api.get("/api/boards/" + boardId)).status()).toBe(404);
  for (const page of [desktop, mobile]) {
    await expect(page.getByRole("heading", { name: "Task pemeriksaan hapus", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Urungkan", exact: true })).toHaveCount(0);
  }
  assert.equal((await api.post("/api/boards/" + boardId + "/restore", { data: { mutationId: crypto.randomUUID() } })).status(), 404);
  assert.deepEqual(errors, [], "The production browser reported an error.");
  const report = {
    url: origin,
    login: true,
    authenticatedApi: true,
    realtimeTwoDevices: true,
    persistedAfterReload: true,
    permanentCardDeletion: true,
    permanentBoardDeletion: true,
    staleRetryRejected: true,
    restoreRejected: true,
    permanentDeleteConfirmation: true,
    taskRichText: true,
    taskTextBlack: true,
    doneButtonRestored: true,
    editorXRemoved: true,
    nativeMobileCardDrag: true,
    mobileDragPersistedAfterReload: true,
    anonymousApiStatus: 401,
    originalBoardCount: original.boards.length,
    browserErrors: errors.length,
  };
  writeFileSync(".cloudflare/qa/production-smoke.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  let message = error instanceof Error ? (error.stack ?? error.message) : "Production verification failed.";
  for (const value of Object.values(values)) if (value) message = message.replaceAll(value, "[redacted]");
  console.error(message);
  process.exitCode = 1;
} finally {
  if (api && boardId) await api.delete("/api/boards/" + boardId, { data: { mutationId: crypto.randomUUID() } }).catch(() => {});
  for (const client of [api, secondApi]) {
    if (client) {
      await client.post("/api/auth/logout", { data: {} }).catch(() => {});
      await client.dispose();
    }
  }
  await browser?.close();
}
