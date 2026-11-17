import { test, expect, type Locator, type Page } from "@playwright/test";
import { textContent, type Card } from "../../lib/model";
const credentials = { username: "test-owner", password: "test-password-not-for-production" };
async function waitForSaved(page: Page) {
  const id = await page.locator(".react-flow__node:has(.canvas-card.editing)").getAttribute("data-id");
  const title = await page.locator(".title-input").inputValue();
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const content = normalize(await page.locator(".card-editor .tiptap").innerText());
  await expect
    .poll(async () => {
      const snapshot = (await (await page.request.get("/api/boards")).json()) as { cards: Card[] };
      const card = snapshot.cards.find((value) => value.id === id);
      return card ? { title: card.title, content: normalize(card.type === "note" ? textContent(card.doc) : card.description) } : null;
    })
    .toEqual({ title, content });
}
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pilih board" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tambahkan kartu", exact: true })).toBeEnabled();
}
async function createBoard(page: Page, name: string) {
  await page.getByRole("button", { name: "Pilih board" }).click();
  await page.getByRole("button", { name: "Buat board", exact: true }).click();
  await page.getByLabel("Nama board", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Buat board", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Pilih board" })).toContainText(name);
}
async function addCard(page: Page, mobile: boolean, type: "note" | "task") {
  await page.getByRole("button", { name: "Tambahkan kartu", exact: true }).click();
  await page.locator(type === "note" ? ".dock-note" : ".dock-task").click();
  await expect(page.getByLabel(type === "note" ? "Judul note" : "Judul task", { exact: true })).toBeVisible();
}
async function focusCard(page: Page, title: string) {
  await page.getByRole("button", { name: "Cari kartu", exact: true }).click();
  await page.getByRole("textbox", { name: "Cari judul atau isi kartu" }).fill(title);
  await page.locator(".search-results>button").filter({ hasText: title }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}
async function readCamera(page: Page) {
  return page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
}
async function pasteText(editor: Locator, text: string) {
  await editor.evaluate((element, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, text);
}
async function toggleFormat(toolbar: Locator, name: string, touch: boolean) {
  const button = toolbar.getByRole("button", { name, exact: true });
  if (touch) await button.tap();
  else await button.click();
}
async function expectFormattingBelowSelection(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selection = window.getSelection();
        const popover = document.querySelector(".format-popover");
        const editor = document.querySelector(".card-editor .tiptap");
        if (!selection?.rangeCount || !popover || !editor) return null;
        const range = selection.getRangeAt(0).cloneRange();
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        const selected: Node[] = [];
        while (walker.nextNode()) if (range.intersectsNode(walker.currentNode)) selected.push(walker.currentNode);
        if (!selected.length) return null;
        const first = selected[0];
        const last = selected[selected.length - 1];
        range.setStart(first, first === range.startContainer ? range.startOffset : 0);
        range.setEnd(last, last === range.endContainer ? range.endOffset : last.textContent!.length);
        return Math.round(popover.getBoundingClientRect().top - range.getBoundingClientRect().bottom);
      })
    )
    .toBe(4);
}
test("touch moves cards, keeps canvas gestures separate, and preserves tap controls", async ({ page, context, isMobile }) => {
  test.skip(!isMobile, "Exercises native touch input on the mobile viewport.");
  await login(page);
  await createBoard(page, "Geser sentuh " + crypto.randomUUID().slice(0, 7));
  const initial = await (await page.request.get("/api/boards")).json();
  const ids = { note: crypto.randomUUID(), task: crypto.randomUUID() };
  for (const type of ["note", "task"] as const) {
    for (const action of [
      { kind: "create", id: ids[type], cardType: type, x: 40, y: type === "note" ? 80 : 430 },
      {
        kind: "content",
        id: ids[type],
        baseVersion: 0,
        title: type === "note" ? "Catatan sentuh" : "Task sentuh",
        description: type === "task" ? "Tarik isi kartu." : "",
        doc: { type: "doc", content: [{ type: "paragraph" }] },
      },
    ]) {
      const response = await page.request.post("/api/boards/" + initial.boardId + "/mutations", {
        headers: { Origin: "http://127.0.0.1:5180" },
        data: { ...action, mutationId: crypto.randomUUID() },
      });
      expect(response.ok()).toBe(true);
    }
  }
  await expect(page.locator(".mobile-card")).toHaveCount(2);
  const client = await context.newCDPSession(page);
  const frame = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const contacts = (points: { x: number; y: number }[]) => points.map((point, index) => ({ ...point, id: index + 1, radiusX: 7, radiusY: 7, force: 1 }));
  const swipe = async (x: number, y: number, dx: number, dy: number) => {
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: contacts([{ x, y }]) });
    for (let step = 1; step <= 12; step++) {
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: contacts([{ x: x + (dx * step) / 12, y: y + (dy * step) / 12 }]) });
      await frame();
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const viewport = () =>
    page.locator(".react-flow__viewport").evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f, zoom: matrix.a };
    });
  const positions = async () =>
    (await (await page.request.get("/api/boards")).json()).cards.map((card: Card) => ({ id: card.id, x: card.x, y: card.y })).sort((a: Card, b: Card) => a.id.localeCompare(b.id));
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/mutations") && request.postDataJSON()?.kind === "layout") writes++;
  });
  for (const [type, dx, dy] of [
    ["note", 35, 80],
    ["task", 20, -20],
  ] as const) {
    const node = page.locator('.react-flow__node[data-id="' + ids[type] + '"]');
    const body = await node.locator(".card-content").boundingBox();
    const before = (await positions()).find((card: Card) => card.id === ids[type])!;
    const camera = await viewport();
    writes = 0;
    await swipe(body!.x + body!.width / 2, body!.y + 38, dx, dy);
    await expect.poll(async () => (await positions()).find((card: Card) => card.id === ids[type])!.x).not.toBe(before.x);
    await expect.poll(() => writes).toBe(1);
    expect(await viewport()).toEqual(camera);
    await expect(page.locator(".card-editor")).toHaveCount(0);
  }
  const saved = await positions();
  writes = 0;
  const beforePan = await viewport();
  await swipe(381, 350, -24, 28);
  await expect.poll(async () => (await viewport()).x).not.toBe(beforePan.x);
  expect(await positions()).toEqual(saved);
  expect(writes).toBe(0);
  const beforeZoom = await viewport();
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: contacts([
      { x: 340, y: 100 },
      { x: 380, y: 180 },
    ]),
  });
  for (let step = 1; step <= 8; step++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: contacts([
        { x: 340 - (10 * step) / 8, y: 100 - (10 * step) / 8 },
        { x: 380 + (10 * step) / 8, y: 180 + (10 * step) / 8 },
      ]),
    });
    await frame();
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await viewport()).zoom).toBeGreaterThan(beforeZoom.zoom + 0.1);
  expect(await positions()).toEqual(saved);
  expect(writes).toBe(0);
  await focusCard(page, "Catatan sentuh");
  await page.getByRole("button", { name: "Edit Catatan sentuh", exact: true }).tap();
  await expect(page.getByLabel("Judul note", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Selesai", exact: true }).tap();
  await expect(page.getByLabel("Judul note", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Selesaikan task", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Tandai belum selesai", exact: true })).toBeVisible();
  const task = page.locator('.react-flow__node[data-id="' + ids.task + '"]');
  await task.getByRole("button", { name: "Menu kartu", exact: true }).tap();
  await expect(task.locator(".card-menu").getByRole("button", { name: "Hapus kartu", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Catatan sentuh", exact: true })).toBeVisible();
  expect(await positions()).toEqual(saved);
});

test("login, rich note, task, drag, filtering, search, and reload", async ({ page, isMobile }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Masuk ke Workspace", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("login.png"), fullPage: true });
  await login(page);
  const boardName = "Uji canvas " + crypto.randomUUID().slice(0, 7);
  await createBoard(page, boardName);
  await addCard(page, isMobile, "note");
  await page.getByLabel("Judul note", { exact: true }).fill("Ide untuk portfolio");
  const prose = page.getByRole("textbox", { name: "Isi note", exact: true });
  await prose.fill("Buat sesuatu yang berarti.");
  await prose.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await prose.press("End");
  await prose.press("Enter");
  await prose.pressSequentially("Satu ide, satu langkah.");
  await waitForSaved(page);
  await page.getByRole("button", { name: "Selesai", exact: true }).click();
  await expect(page.getByLabel("Judul note", { exact: true })).not.toBeVisible();
  const node = page.locator(".react-flow__node").filter({ hasText: "Ide untuk portfolio" });
  if (!isMobile) {
    const handle = await node.locator(".card-drag-handle").boundingBox();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x - 230, handle!.y - 120, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(".sync-status")).toContainText("Tersinkron");
    const before = await (await page.request.get("/api/boards")).json();
    const note = before.cards.find((card: { type: string }) => card.type === "note");
    await node.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => {
        const current = await (await page.request.get("/api/boards")).json();
        return current.cards.find((card: { id: string }) => card.id === note.id).x;
      })
      .toBe(note.x + 10);
  }
  await addCard(page, isMobile, "task");
  await page.getByLabel("Judul task", { exact: true }).fill("Kirim draft pertama");
  await page.getByLabel("Deskripsi task", { exact: true }).fill("Mulai dari halaman utama.");
  await waitForSaved(page);
  await page.getByRole("button", { name: "Selesai", exact: true }).click();
  await focusCard(page, "Kirim draft pertama");
  await page.getByRole("button", { name: "Selesaikan task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tandai belum selesai", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sembunyikan task selesai", exact: true }).click();
  await expect(page.locator(".canvas-card.completed")).toHaveCount(0);
  await page.getByRole("button", { name: "Tampilkan task selesai", exact: true }).click();
  await page.getByRole("button", { name: "Cari kartu", exact: true }).click();
  await page.getByRole("textbox", { name: "Cari judul atau isi kartu" }).fill("portfolio");
  await expect(page.locator(".search-results>button")).toHaveCount(1);
  await page.getByRole("button", { name: "Tutup", exact: true }).click();
  await page.getByRole("button", { name: "Perkecil canvas", exact: true }).click();
  await page.getByRole("button", { name: "Perkecil canvas", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("canvas.png"), fullPage: true });
  await page.reload();
  await expect(page.getByRole("button", { name: "Pilih board" })).toContainText(boardName);
  await expect(page.getByRole("heading", { name: "Ide untuk portfolio", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tandai belum selesai", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test("two devices sync changes without refreshing", async ({ browser, page, isMobile }) => {
  await login(page);
  const boardName = "Sinkron " + crypto.randomUUID().slice(0, 7);
  await createBoard(page, boardName);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const other = await context.newPage();
  await login(other);
  await other.getByRole("button", { name: "Pilih board" }).click();
  await other.getByRole("button", { name: boardName, exact: true }).click();
  await expect(other.getByRole("button", { name: "Pilih board" })).toContainText(boardName);
  await addCard(page, isMobile, "task");
  await page.getByLabel("Judul task", { exact: true }).fill("Terlihat di dua perangkat");
  await waitForSaved(page);
  await page.getByRole("button", { name: "Selesai", exact: true }).click();
  await expect(other.getByRole("heading", { name: "Terlihat di dua perangkat" })).toBeVisible();
  await other.getByRole("button", { name: "Selesaikan task" }).click();
  await expect(page.getByRole("button", { name: "Tandai belum selesai" })).toBeVisible();
  await context.close();
});
test("contextual formatting preserves selection and card menu only deletes", async ({ page, isMobile }, testInfo) => {
  await login(page);
  await createBoard(page, "Editor " + crypto.randomUUID().slice(0, 7));
  await expect(page.locator(".canvas-caption")).toHaveCount(0);
  await addCard(page, isMobile, "note");
  const title = page.getByLabel("Judul note", { exact: true });
  const prose = page.getByRole("textbox", { name: "Isi note", exact: true });
  const toolbar = page.getByRole("toolbar", { name: "Format tulisan", exact: true });
  await title.fill("Catatan sederhana");
  await prose.fill("Teks untuk diformat");
  await prose.press("Escape");
  await title.click();
  await expect(toolbar).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("editor-clean.png"), fullPage: true });
  if (!isMobile) {
    const before = await prose.boundingBox();
    await prose.hover();
    await expect(toolbar).not.toBeVisible();
    expect((await prose.boundingBox())!.height).toBe(before!.height);
    await page.getByRole("button", { name: "Pilih board", exact: true }).hover();
    await expect(toolbar).not.toBeVisible();
  }
  await prose.click();
  await prose.press("ControlOrMeta+A");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Tambahkan tautan", exact: true })).toHaveCount(0);
  await expectFormattingBelowSelection(page);
  expect((await page.locator(".format-popover").boundingBox())!.height).toBeLessThan(isMobile ? 46 : 38);
  if (!isMobile) {
    const before = (await prose.boundingBox())!.y;
    await page.mouse.move(100, 100);
    await page.mouse.wheel(0, 96);
    await expect.poll(async () => (await prose.boundingBox())!.y).not.toBe(before);
    await expectFormattingBelowSelection(page);
  }
  await toggleFormat(toolbar, "Bold", isMobile);
  await expect(prose.locator("strong")).toHaveText("Teks untuk diformat");
  await toggleFormat(toolbar, "Italic", isMobile);
  await expect(prose.locator("em")).toHaveText("Teks untuk diformat");
  await expect(prose.locator("em")).toHaveCSS("font-style", "italic");
  // Check the actual italic faces: computed font-style alone also passes when synthesis is disabled and the face is missing.
  expect(await page.evaluate(async () => (await document.fonts.load('italic 400 13px "Instrument Sans"')).length)).toBeGreaterThan(0);
  expect(await page.evaluate(async () => (await document.fonts.load('italic 700 13px "Instrument Sans"')).length)).toBeGreaterThan(0);
  await toggleFormat(toolbar, "Bullet", isMobile);
  await expect(prose.locator("ul li")).toHaveText("Teks untuk diformat");
  await expect(prose.locator("ul")).toHaveCSS("list-style-type", "disc");
  for (const name of ["Bold", "Italic", "Bullet"]) await expect(toolbar.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expectFormattingBelowSelection(page);
  await page.screenshot({ path: testInfo.outputPath("editor-selection.png"), fullPage: true });
  // Each format can be removed and reapplied to the same selection.
  for (const name of ["Bullet", "Italic", "Bold"]) {
    await toggleFormat(toolbar, name, isMobile);
    await expect(toolbar.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "false");
  }
  await expect(prose.locator("strong, em, ul")).toHaveCount(0);
  for (const name of ["Bold", "Italic", "Bullet"]) await toggleFormat(toolbar, name, isMobile);
  await prose.press("ArrowRight");
  await expect(toolbar).not.toBeVisible();
  await pasteText(prose, " Lihat https://example.com/catatan untuk detail.");
  await expect(prose.locator("a")).toHaveAttribute("href", "https://example.com/catatan");
  await expect(prose.locator("a")).toHaveCSS("color", "rgb(20, 115, 230)");
  await expect(toolbar).not.toBeVisible();
  await waitForSaved(page);
  await prose.press("ControlOrMeta+A");
  await expect(toolbar).toBeVisible();
  await prose.press("Escape");
  await expect(toolbar).not.toBeVisible();
  await expect(title).toBeVisible();
  await title.click();
  await expect(toolbar).not.toBeVisible();
  await waitForSaved(page);
  await page.getByRole("button", { name: "Selesai", exact: true }).click();
  await expect(title).not.toBeVisible();
  await page.reload();
  await expect(page.locator(".note-preview strong").first()).toContainText("Teks untuk diformat");
  await expect(page.locator(".note-preview em").first()).toContainText("Teks untuk diformat");
  await expect(page.locator(".note-preview ul li")).toHaveCount(1);
  await expect(page.locator(".note-preview a")).toHaveAttribute("href", "https://example.com/catatan");
  await expect(page.locator(".note-preview a")).toHaveCSS("color", "rgb(20, 115, 230)");
  if (!isMobile) await page.locator(".canvas-card").hover();
  await page.getByRole("button", { name: "Menu kartu", exact: true }).click();
  const menu = page.locator(".card-menu");
  await expect(menu.getByRole("button")).toHaveCount(1);
  await expect(menu.getByRole("button")).toHaveText("Hapus kartu");
  await page.screenshot({ path: testInfo.outputPath("card-menu.png"), fullPage: true });
  await menu.getByRole("button", { name: "Hapus kartu", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Catatan sederhana", exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Urungkan", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Catatan sederhana", exact: true })).toHaveCount(0);
  const snapshot = await (await page.request.get("/api/boards")).json();
  expect(snapshot.cards).toEqual([]);
  await page.getByRole("button", { name: "Pilih board", exact: true }).click();
  await page.getByRole("button", { name: "Hapus board", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("akan dihapus permanen");
  await expect(page.getByRole("dialog")).not.toContainText("disembunyikan");
  await page.getByRole("dialog").getByRole("button", { name: "Hapus board", exact: true }).click();
  await expect.poll(async () => (await page.request.get("/api/boards/" + snapshot.boardId)).status()).toBe(404);
  await expect(page.getByRole("button", { name: "Urungkan", exact: true })).toHaveCount(0);
});

test("task descriptions preserve legacy text and support contextual formatting", async ({ page, isMobile }, testInfo) => {
  await login(page);
  await createBoard(page, "Format task " + crypto.randomUUID().slice(0, 7));
  const snapshot = await (await page.request.get("/api/boards")).json();
  const id = crypto.randomUUID();
  const mutate = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/boards/" + snapshot.boardId + "/mutations", {
      headers: { Origin: "http://127.0.0.1:5180" },
      data: { ...data, mutationId: crypto.randomUUID() },
    });
    expect(response.ok()).toBe(true);
  };
  await mutate({ kind: "create", id, cardType: "task", x: 250, y: 220 });
  await mutate({
    kind: "content",
    id,
    baseVersion: 0,
    title: "Task dengan format",
    description: "Baris pertama\nBaris kedua",
    doc: { type: "doc", content: [{ type: "paragraph" }] },
  });
  await page.getByRole("button", { name: "Edit Task dengan format", exact: true }).click();
  const description = page.getByRole("textbox", { name: "Deskripsi task", exact: true });
  const toolbar = page.getByRole("toolbar", { name: "Format tulisan", exact: true });
  await expect(description).toContainText("Baris pertama");
  await expect(description).toContainText("Baris kedua");
  expect(await description.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(22, 22, 22)");
  await page.screenshot({ path: testInfo.outputPath("task-editor-clean.png"), fullPage: true });
  if (!isMobile) {
    await description.hover();
    await expect(toolbar).not.toBeVisible();
  }
  await description.press("ControlOrMeta+A");
  await expect(toolbar).toBeVisible();
  await toggleFormat(toolbar, "Bold", isMobile);
  await toggleFormat(toolbar, "Italic", isMobile);
  await toggleFormat(toolbar, "Bullet", isMobile);
  await expect(description.locator("li")).toHaveCount(2);
  await expect(description.locator("em").first()).toHaveCSS("font-style", "italic");
  await expectFormattingBelowSelection(page);
  await page.screenshot({ path: testInfo.outputPath("task-editor-format.png"), fullPage: true });
  await description.press("ArrowRight");
  await expect(toolbar).not.toBeVisible();
  await pasteText(description, " https://example.com/task");
  await expect(description.locator("a")).toHaveAttribute("href", "https://example.com/task");
  await expect(description.locator("a")).toHaveCSS("color", "rgb(20, 115, 230)");
  await page.getByRole("button", { name: "Selesai", exact: true }).click();
  await expect(description).not.toBeVisible();
  await page.reload();
  const preview = page.locator(".task-preview");
  await expect(preview.locator("li")).toHaveCount(2);
  await expect(preview.locator("strong").first()).toHaveText("Baris pertama");
  await expect(preview.locator("em").first()).toHaveText("Baris pertama");
  await expect(preview.locator("a").first()).toHaveAttribute("href", "https://example.com/task");
  await expect(preview.locator("a")).toHaveCSS("color", "rgb(20, 115, 230)");
  expect(await preview.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(22, 22, 22)");
  const saved = (await (await page.request.get("/api/boards")).json()).cards.find((card: Card) => card.id === id);
  expect(saved.description.trimEnd()).toBe("Baris pertama\nBaris kedua https://example.com/task");
  await page.getByRole("button", { name: "Selesaikan task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tandai belum selesai", exact: true })).toBeVisible();
});

test("one close click waits for an in-flight autosave and persists the draft", async ({ page, isMobile }) => {
  await login(page);
  await createBoard(page, "Simpan saat tutup " + crypto.randomUUID().slice(0, 7));
  await addCard(page, isMobile, "task");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/boards/*/mutations", async (route) => {
    if (route.request().postDataJSON()?.kind === "content") {
      started.resolve();
      await release.promise;
    }
    await route.continue();
  });
  try {
    const title = page.getByLabel("Judul task", { exact: true });
    await title.fill("Edit terakhir tetap tersimpan");
    await started.promise;
    await page.getByRole("button", { name: "Selesai", exact: true }).click();
    await expect(title).toBeVisible();
    release.resolve();
    await expect(title).not.toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Edit terakhir tetap tersimpan", exact: true })).toBeVisible();
  } finally {
    release.resolve();
  }
});

test("keeps offline drafts and resolves concurrent text edits explicitly", async ({ browser, page, context, isMobile }) => {
  await login(page);
  const boardName = "Konflik " + crypto.randomUUID().slice(0, 7);
  await createBoard(page, boardName);
  await addCard(page, isMobile, "task");
  await page.getByLabel("Judul task", { exact: true }).fill("Judul awal");
  await waitForSaved(page);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await login(other);
  await other.getByRole("button", { name: "Pilih board" }).click();
  await other.getByRole("button", { name: boardName, exact: true }).click();
  await other.getByRole("button", { name: "Edit Judul awal", exact: true }).click();
  await context.setOffline(true);
  await page.getByLabel("Judul task", { exact: true }).fill("Draft di perangkat ini");
  expect((await (await other.request.get("/api/boards")).json()).cards[0].title).toBe("Judul awal");
  await other.getByLabel("Judul task", { exact: true }).fill("Versi perangkat lain");
  await waitForSaved(other);
  await context.setOffline(false);
  await expect(page.getByText("Ada versi dari perangkat lain", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Judul task", { exact: true })).toHaveValue("Draft di perangkat ini");
  await page.getByRole("button", { name: "Simpan versi perangkat ini", exact: true }).click();
  await waitForSaved(page);
  await expect(other.getByLabel("Judul task", { exact: true })).toHaveValue("Draft di perangkat ini");
  await page.getByRole("button", { name: "Selesai", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Draft di perangkat ini", exact: true })).toBeVisible();
  await otherContext.close();
});
test("closes a remotely deleted card without offering restoration", async ({ page, context, isMobile }) => {
  await login(page);
  await createBoard(page, "Pemulihan " + crypto.randomUUID().slice(0, 7));
  await addCard(page, isMobile, "task");
  await page.getByLabel("Judul task", { exact: true }).fill("Sebelum dihapus");
  await waitForSaved(page);
  const snapshot = await (await page.request.get("/api/boards")).json();
  const cardId = snapshot.cards[0].id as string;
  await context.setOffline(true);
  await page.getByLabel("Judul task", { exact: true }).fill("Draft yang harus tetap ada");
  const cookieState = await context.cookies();
  const response = await fetch("http://127.0.0.1:5180/api/boards/" + snapshot.boardId + "/mutations", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:5180", "Content-Type": "application/json", Cookie: cookieState.map((c) => c.name + "=" + c.value).join("; ") },
    body: JSON.stringify({ kind: "delete", id: cardId, mutationId: crypto.randomUUID() }),
  });
  expect(response.status).toBe(200);
  await context.setOffline(false);
  await expect(page.getByLabel("Judul task", { exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Pulihkan dan simpan draft", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Draft yang harus tetap ada", exact: true })).toHaveCount(0);
  expect((await (await page.request.get("/api/boards")).json()).cards).toEqual([]);
});
test("tidies every card, syncs positions without moving another camera, and undoes for 15 seconds", async ({ page, browser }, testInfo) => {
  test.setTimeout(90000);
  await login(page);
  const boardName = "Rapikan " + crypto.randomUUID().slice(0, 7);
  await createBoard(page, boardName);
  const initial = await (await page.request.get("/api/boards")).json();
  const post = async (action: Record<string, unknown>) => {
    const response = await page.request.post("/api/boards/" + initial.boardId + "/mutations", {
      headers: { Origin: "http://127.0.0.1:5180" },
      data: { ...action, mutationId: crypto.randomUUID() },
    });
    expect(response.ok()).toBe(true);
  };
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  for (let i = 0; i < ids.length; i++) {
    await post({ kind: "create", cardType: i % 2 ? "task" : "note", id: ids[i], x: i % 2 ? 90000 : -80000, y: i * 2000 - 4000 });
    await post({ kind: "layout", id: ids[i], width: [240, 560, 280, 320, 400][i] });
    await post({
      kind: "content",
      id: ids[i],
      baseVersion: 0,
      title: "Kartu " + i + " untuk menguji susunan campuran",
      description: i % 2 ? "Isi task yang tetap tersimpan." : "",
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Catatan dengan isi panjang. ".repeat(i * 12 + 1) }] }] },
    });
  }
  await post({ kind: "complete", id: ids[1], completed: true });
  const before = (await (await page.request.get("/api/boards")).json()) as { cards: Card[]; seq: number };
  const positions = (cards: Card[]) => cards.map(({ id, x, y }) => ({ id, x, y })).sort((a, b) => a.id.localeCompare(b.id));
  await page.getByRole("button", { name: "Sembunyikan task selesai", exact: true }).click();
  const otherContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const other = await otherContext.newPage();
    await login(other);
    await other.getByRole("button", { name: "Pilih board" }).click();
    await other.getByRole("button", { name: boardName, exact: true }).click();
    await expect(other.getByRole("button", { name: "Tambahkan kartu", exact: true })).toBeEnabled();
    const otherCamera = await readCamera(other),
      previousCamera = await readCamera(page);
    let writes = 0;
    let measured: { id: string; height: number }[] = [];
    await page.route("**/mutations", async (route) => {
      if (route.request().postDataJSON()?.kind === "layout.batch") {
        writes++;
        const sizes = await page
          .locator("[data-measure-id]")
          .evaluateAll((elements) => elements.map((element) => ({ id: (element as HTMLElement).dataset.measureId!, height: Math.ceil(element.getBoundingClientRect().height) })));
        if (sizes.length) measured = sizes;
      }
      await route.continue();
    });
    const tidy = page.getByRole("button", { name: "Rapikan kartu", exact: true });
    await expect(page.getByRole("button", { name: "Lihat semua kartu", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Alat pilih", exact: true })).toBeVisible();
    await tidy.click();
    const undo = page.getByRole("button", { name: "Urungkan", exact: true });
    await expect(undo).toBeVisible();
    await expect(tidy).toBeEnabled();
    expect(writes).toBe(1);
    expect(measured).toHaveLength(5);
    const after = (await (await page.request.get("/api/boards")).json()) as { cards: Card[]; seq: number };
    expect(after.seq).toBe(before.seq + 1);
    expect(after.cards.find((card) => card.id === ids[1])!.x).toBe(588);
    for (let i = 0; i < after.cards.length; i++)
      for (let j = i + 1; j < after.cards.length; j++) {
        const a = after.cards[i],
          b = after.cards[j];
        const ah = measured.find((card) => card.id === a.id)!.height,
          bh = measured.find((card) => card.id === b.id)!.height;
        expect(a.x + a.width + 28 <= b.x || b.x + b.width + 28 <= a.x || a.y + ah + 28 <= b.y || b.y + bh + 28 <= a.y).toBe(true);
      }
    await expect(other.locator('.react-flow__node[data-id="' + ids[0] + '"]')).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    expect(await readCamera(other)).toEqual(otherCamera);
    const surface = await page.locator(".canvas-surface").boundingBox();
    const boxes = await page.locator(".react-flow__node").evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, bottom: box.bottom };
      })
    );
    for (const box of boxes) {
      expect(box.left).toBeGreaterThan(surface!.x + 15);
      expect(box.right).toBeLessThan(surface!.x + surface!.width - 15);
      expect(box.bottom).toBeLessThan(surface!.y + surface!.height - 100);
    }
    await page.screenshot({ path: testInfo.outputPath("tidy.png"), fullPage: true });
    await undo.click();
    await expect(page.getByText("Susunan sebelumnya dikembalikan.", { exact: true })).toBeVisible();
    expect(positions((await (await page.request.get("/api/boards")).json()).cards)).toEqual(positions(before.cards));
    expect(await readCamera(page)).toEqual(previousCamera);
    expect(writes).toBe(2);
    await tidy.click();
    await expect(undo).toBeVisible();
    await post({ kind: "layout", id: ids[0], x: 45, y: 55 });
    await expect(undo).toHaveCount(0);
    await tidy.click();
    await expect(undo).toBeVisible();
    await expect(undo).toHaveCount(0, { timeout: 17000 });
    const persisted = positions((await (await page.request.get("/api/boards")).json()).cards);
    const persistedCamera = await readCamera(page);
    await page.reload();
    await expect(tidy).toBeEnabled();
    expect(positions((await (await page.request.get("/api/boards")).json()).cards)).toEqual(persisted);
    expect(await readCamera(page)).toEqual(persistedCamera);
    await expect(page.locator("[data-measure-id]")).toHaveCount(0);
  } finally {
    await otherContext.close();
  }
});

test("places new cards beside existing cards even after panning far away", async ({ page, isMobile }) => {
  await login(page);
  await createBoard(page, "Dekat " + crypto.randomUUID().slice(0, 7));
  await expect(page.getByRole("button", { name: "Rapikan kartu", exact: true })).toBeDisabled();
  const initial = await (await page.request.get("/api/boards")).json();
  const id = crypto.randomUUID();
  for (const action of [
    { kind: "create", cardType: "task", id, x: -4000, y: -3000 },
    { kind: "complete", id, completed: true },
  ]) {
    const response = await page.request.post("/api/boards/" + initial.boardId + "/mutations", {
      headers: { Origin: "http://127.0.0.1:5180" },
      data: { ...action, mutationId: crypto.randomUUID() },
    });
    expect(response.ok()).toBe(true);
  }
  await page.getByRole("button", { name: "Sembunyikan task selesai", exact: true }).click();
  const camera = await readCamera(page);
  await page.getByRole("button", { name: "Rapikan kartu", exact: true }).click();
  await expect(page.getByRole("button", { name: "Urungkan", exact: true })).toBeVisible();
  expect(await readCamera(page)).toEqual(camera);
  await page.getByRole("button", { name: "Urungkan", exact: true }).click();
  await expect(page.getByText("Susunan sebelumnya dikembalikan.", { exact: true })).toBeVisible();
  await addCard(page, isMobile, "note");
  const cards = (await (await page.request.get("/api/boards")).json()).cards as Card[];
  const added = cards.find((card) => card.id !== id)!;
  expect(Math.abs(added.x + 4000)).toBeLessThan(600);
  expect(Math.abs(added.y + 3000)).toBeLessThan(600);
  const old = cards.find((card) => card.id === id)!;
  expect(added.x + added.width + 28 <= old.x || old.x + old.width + 28 <= added.x || added.y + 228 + 28 <= old.y || old.y + 228 + 28 <= added.y).toBe(true);
  await expect(page.getByRole("button", { name: "Rapikan kartu", exact: true, includeHidden: true })).toBeDisabled();
  await page.getByRole("button", { name: "Selesai", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rapikan kartu", exact: true })).toBeEnabled();
});

test("keeps a 300-card board usable and writes once per drag", async ({ page, isMobile }) => {
  test.skip(isMobile, "Large board runtime check runs once on desktop.");
  test.setTimeout(180000);
  await login(page);
  await createBoard(page, "Banyak kartu " + crypto.randomUUID().slice(0, 7));
  const data = await (await page.request.get("/api/boards")).json();
  for (let start = 0; start < 300; start += 12) {
    await Promise.all(
      Array.from({ length: Math.min(12, 300 - start) }, async (_, offset) => {
        const i = start + offset;
        const response = await page.request.post("/api/boards/" + data.boardId + "/mutations", {
          headers: { Origin: "http://127.0.0.1:5180" },
          data: { kind: "create", cardType: i % 2 ? "note" : "task", id: crypto.randomUUID(), mutationId: crypto.randomUUID(), x: (i % 20) * 330, y: Math.floor(i / 20) * 230 },
        });
        expect(response.ok()).toBe(true);
      })
    );
  }
  await expect.poll(async () => (await (await page.request.get("/api/boards")).json()).cards.length).toBe(300);
  expect(await page.locator(".react-flow__node").count()).toBeLessThan(100);
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/mutations")) writes++;
  });
  const handle = await page.locator(".card-drag-handle").first().boundingBox();
  await page.mouse.move(handle!.x + 12, handle!.y + 12);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 70, handle!.y + 70, { steps: 25 });
  await page.mouse.up();
  await expect.poll(() => writes).toBe(1);
  await page.getByRole("button", { name: "Rapikan kartu", exact: true }).click();
  await expect(page.getByRole("button", { name: "Urungkan", exact: true })).toBeVisible();
  expect(writes).toBe(2);
  const arranged = (await (await page.request.get("/api/boards")).json()).cards as Card[];
  expect(new Set(arranged.map((card) => card.x)).size).toBe(4);
  expect(Math.max(...arranged.map((card) => card.y))).toBeLessThan(20000);
  await expect(page.getByRole("button", { name: "Perbesar canvas", exact: true })).toBeEnabled();
});
