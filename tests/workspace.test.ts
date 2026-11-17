/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, evictDurableObject } from "cloudflare:test";
import worker from "../worker/index";
import type { WorkspaceRoom } from "../worker/objects";
import { emptyDoc, type Card, type RoomEvent, type Snapshot } from "../lib/model";

const origin = "https://workspace.test";
const room = () => (env.WORKSPACE as DurableObjectNamespace<WorkspaceRoom>).getByName("personal");
function api(path: string, method = "GET", value?: unknown, token = "", ip = crypto.randomUUID()) {
  const headers = new Headers({ Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": ip });
  if (token) headers.set("Cookie", token);
  return worker.fetch(new Request(origin + path, { method, headers, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) }), env, createExecutionContext());
}
async function login(ip?: string) {
  const response = await api("/api/auth/login", "POST", { username: "test-owner", password: "test-password-not-for-production" }, "", ip);
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
async function setup() {
  const token = await login();
  const data = (await (await api("/api/boards", "GET", undefined, token)).json()) as Snapshot;
  return { token, boardId: data.boardId!, data };
}
async function mutate(token: string, boardId: string, value: Record<string, unknown>) {
  return api("/api/boards/" + boardId + "/mutations", "POST", { mutationId: crypto.randomUUID(), ...value }, token);
}
beforeAll(async () => {
  for (const statement of inject("schema")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await env.DB.prepare(statement).run();
});
beforeEach(async () => {
  await env.DB.prepare("DROP TRIGGER IF EXISTS fail_card").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS fail_delete").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS fail_layout").run();
  for (const table of ["cards", "boards", "workspaces", "sessions", "login_limits", "device_state", "mutation_receipts"]) await env.DB.prepare("DELETE FROM " + table).run();
});

describe("login and access", () => {
  it("rejects unauthenticated data access and foreign origins", async () => {
    expect((await api("/api/boards")).status).toBe(401);
    const response = await worker.fetch(new Request(origin + "/api/auth/login", { method: "POST", headers: { Origin: "https://other.test" } }), env, createExecutionContext());
    expect(response.status).toBe(403);
  });
  it("sets secure cookies, stores only token hashes, and revokes sessions", async () => {
    const response = await api("/api/auth/login", "POST", { username: "test-owner", password: "test-password-not-for-production" });
    const cookies = response.headers.getSetCookie();
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("Secure");
    expect(cookies[0]).toContain("SameSite=Strict");
    const token = cookies.map((c) => c.split(";")[0]).join("; ");
    const stored = await env.DB.prepare("SELECT token_hash FROM sessions").first<{ token_hash: string }>();
    expect(token).not.toContain(stored!.token_hash);
    expect((await api("/api/auth/session", "GET", undefined, token)).status).toBe(200);
    expect((await api("/api/auth/logout", "POST", {}, token)).status).toBe(200);
    expect((await api("/api/boards", "GET", undefined, token)).status).toBe(401);
  });
  it("enforces the failed-login limit even for simultaneous requests", async () => {
    const ip = crypto.randomUUID();
    const attempts = await Promise.all(Array.from({ length: 8 }, () => api("/api/auth/login", "POST", { username: "wrong", password: "wrong" }, "", ip)));
    expect(attempts.filter((r) => r.status === 401)).toHaveLength(4);
    expect(attempts.filter((r) => r.status === 429)).toHaveLength(4);
    expect((await api("/api/auth/login", "POST", { username: "test-owner", password: "test-password-not-for-production" }, "", ip)).status).toBe(429);
    expect(await login()).toContain("workspace_session=");
    await env.DB.prepare("UPDATE login_limits SET blocked_until=0, window_start=0, request_window=0 WHERE blocked_until>0").run();
    expect(await login(ip)).toContain("workspace_session=");
  });
  it("rejects expired sessions", async () => {
    const token = await login();
    await env.DB.prepare("UPDATE sessions SET expires_at=0").run();
    expect((await api("/api/boards", "GET", undefined, token)).status).toBe(401);
  });
});
describe("D1 and workspace mutations", () => {
  it("starts with one empty board and survives Durable Object eviction", async () => {
    const { data, token } = await setup();
    expect(data.boards).toHaveLength(1);
    expect(data.cards).toEqual([]);
    await evictDurableObject(room());
    const after = (await (await api("/api/boards", "GET", undefined, token)).json()) as Snapshot;
    expect(after.boards).toEqual(data.boards);
  });
  it("commits retries once and rejects reusing an ID with different content", async () => {
    const { token, boardId } = await setup();
    const value = { kind: "create", cardType: "note", id: crypto.randomUUID(), mutationId: crypto.randomUUID(), x: 10, y: 20 };
    const first = await mutate(token, boardId, value),
      retry = await mutate(token, boardId, value);
    expect(await first.json()).toEqual(await retry.json());
    expect((await mutate(token, boardId, { ...value, x: 30 })).status).toBe(409);
    const data = await room().snapshot(boardId, crypto.randomUUID());
    expect(data.cards).toHaveLength(1);
    expect(data.seq).toBe(1);
  });
  it("serializes concurrent edits and retains unrelated fields", async () => {
    const { token, boardId } = await setup(),
      id = crypto.randomUUID();
    await mutate(token, boardId, { kind: "create", cardType: "task", id, x: 0, y: 0 });
    const updates = await Promise.all(
      ["First", "Second"].map((title) => mutate(token, boardId, { kind: "content", id, baseVersion: 0, title, description: "details", doc: emptyDoc }))
    );
    expect(updates.map((r) => r.status).sort()).toEqual([200, 409]);
    const conflict = (await updates.find((r) => r.status === 409)!.json()) as { current: Card };
    expect(conflict.current.contentVersion).toBe(1);
    await mutate(token, boardId, { kind: "layout", id, x: 340, y: -80, width: 440 });
    await mutate(token, boardId, { kind: "complete", id, completed: true });
    const card = (await room().snapshot(boardId, crypto.randomUUID())).cards[0];
    expect(card.title).toBe(conflict.current.title);
    expect(card.x).toBe(340);
    expect(card.completed).toBe(true);
  });
  it("commits and undoes batch positions once, preserves card content, and rejects stale edits", async () => {
    const { token, boardId } = await setup();
    for (let i = 0; i < 2; i++) await mutate(token, boardId, { kind: "create", cardType: i ? "task" : "note", id: crypto.randomUUID(), x: i * 30000, y: -500 });
    const before = await room().snapshot(boardId, "device");
    const positions = before.cards.map((card, i) => ({ id: card.id, x: i * 308, y: 0 }));
    const action = { kind: "layout.batch", baseSeq: before.seq, positions, mutationId: crypto.randomUUID() };
    const response = await mutate(token, boardId, action);
    expect(response.status).toBe(200);
    const event = (await response.json()) as RoomEvent;
    expect(event.layout).toMatchObject({ boardId, positions });
    expect(event.card).toBeUndefined();
    expect(event.seq).toBe(before.seq + 1);
    expect(await (await mutate(token, boardId, action)).json()).toEqual(event);
    expect((await mutate(token, boardId, { ...action, mutationId: crypto.randomUUID() })).status).toBe(409);
    const after = await room().snapshot(boardId, "device");
    expect(after.seq).toBe(event.seq);
    for (const card of after.cards) {
      const prior = before.cards.find((value) => value.id === card.id)!;
      expect(card).toEqual({ ...prior, ...positions.find((position) => position.id === card.id), updatedAt: event.layout!.updatedAt });
    }
    const undo = await mutate(token, boardId, { kind: "layout.batch", baseSeq: after.seq, positions: before.cards.map(({ id, x, y }) => ({ id, x, y })) });
    expect(undo.status).toBe(200);
    expect((await room().snapshot(boardId, "device")).cards.map(({ id, x, y }) => ({ id, x, y }))).toEqual(before.cards.map(({ id, x, y }) => ({ id, x, y })));
    await evictDurableObject(room());
    expect((await room().snapshot(boardId, "device")).seq).toBe(after.seq + 1);
  });
  it("rejects invalid batch members and rolls back every position and receipt on failure", async () => {
    const { token, boardId } = await setup();
    for (let i = 0; i < 2; i++) await mutate(token, boardId, { kind: "create", cardType: "note", id: crypto.randomUUID(), x: i * 100, y: 5 });
    const before = await room().snapshot(boardId, "device");
    const positions = before.cards.map((card, i) => ({ id: card.id, x: i * 308, y: 0 }));
    const batch = { kind: "layout.batch", baseSeq: before.seq, positions };
    for (const invalid of [[], [positions[0], positions[0]], [{ ...positions[0], x: 1000001 }]])
      expect((await mutate(token, boardId, { ...batch, positions: invalid })).status).toBe(400);
    expect((await mutate(token, boardId, { ...batch, positions: [positions[0], { ...positions[1], id: crypto.randomUUID() }] })).status).toBe(404);
    const otherId = crypto.randomUUID();
    await api("/api/boards", "POST", { boardId: otherId, name: "Other", mutationId: crypto.randomUUID() }, token);
    const seq = (await room().snapshot(boardId, "device")).seq;
    expect((await mutate(token, otherId, { ...batch, baseSeq: seq })).status).toBe(404);
    const receipts = (await env.DB.prepare("SELECT COUNT(*) AS n FROM mutation_receipts").first<{ n: number }>())!.n;
    await env.DB.prepare("CREATE TRIGGER fail_layout BEFORE UPDATE ON cards WHEN NEW.id = '" + positions[1].id + "' BEGIN SELECT RAISE(ABORT, 'forced test failure'); END").run();
    expect((await mutate(token, boardId, { ...batch, baseSeq: seq })).status).toBe(503);
    const after = await room().snapshot(boardId, "device");
    expect(after.cards).toEqual(before.cards);
    expect(after.seq).toBe(seq);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM mutation_receipts").first<{ n: number }>())!.n).toBe(receipts);
  });
  it("keeps batch retries from restoring deleted cards or boards", async () => {
    const { token, boardId } = await setup();
    const id = crypto.randomUUID();
    await mutate(token, boardId, { kind: "create", cardType: "note", id, x: 400, y: 700 });
    const batch = { kind: "layout.batch", baseSeq: 1, positions: [{ id, x: 0, y: 0 }], mutationId: crypto.randomUUID() };
    const event = await (await mutate(token, boardId, batch)).json();
    await mutate(token, boardId, { kind: "delete", id });
    expect(await (await mutate(token, boardId, batch)).json()).toEqual(event);
    expect((await room().snapshot(boardId, "device")).cards).toEqual([]);
    expect((await mutate(token, boardId, { ...batch, mutationId: crypto.randomUUID(), baseSeq: 3 })).status).toBe(404);
    await api("/api/boards/" + boardId, "DELETE", { mutationId: crypto.randomUUID() }, token);
    expect((await mutate(token, boardId, batch)).status).toBe(410);
  });
  it("physically deletes cards, erases receipt content, and rejects restoration and stale retries", async () => {
    const { token, boardId } = await setup(),
      id = crypto.randomUUID();
    const create = { kind: "create", cardType: "note", id, x: 2, y: 3, mutationId: crypto.randomUUID() };
    await mutate(token, boardId, create);
    await mutate(token, boardId, { kind: "content", id, baseVersion: 0, title: "erase-card-content", description: "erase-card-description", doc: emptyDoc });
    const deletion = { kind: "delete", id, mutationId: crypto.randomUUID() };
    const response = await mutate(token, boardId, deletion);
    const event = (await response.json()) as RoomEvent;
    expect(event.deletedCard).toEqual({ id, boardId });
    expect(event.card).toBeUndefined();
    expect((await room().snapshot(boardId, "device")).cards).toHaveLength(0);
    expect(await env.DB.prepare("SELECT id FROM cards WHERE id = ?").bind(id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM mutation_receipts WHERE response LIKE '%erase-card-%'").first()).toBeNull();
    expect(await (await mutate(token, boardId, deletion)).json()).toEqual(event);
    expect((await mutate(token, boardId, create)).status).toBe(410);
    expect((await mutate(token, boardId, { kind: "restore", id })).status).toBe(400);
    expect((await mutate(token, boardId, { kind: "content", id, baseVersion: 1, title: "resurrect", description: "", doc: emptyDoc })).status).toBe(404);
    expect(await env.DB.prepare("SELECT id FROM cards WHERE id = ?").bind(id).first()).toBeNull();
  });
  it("physically deletes boards, all their cards and device views without retaining their content", async () => {
    const { token, boardId } = await setup();
    await api("/api/boards/" + boardId, "PATCH", { name: "erase-board-name", mutationId: crypto.randomUUID() }, token);
    for (let i = 0; i < 2; i++) {
      const id = crypto.randomUUID();
      await mutate(token, boardId, { kind: "create", cardType: i ? "note" : "task", id, x: 0, y: 0 });
      await mutate(token, boardId, { kind: "content", id, baseVersion: 0, title: "erase-board-card", description: "", doc: emptyDoc });
    }
    await room().saveView(boardId, "desktop", { x: 1, y: 2, zoom: 1, hideCompleted: false });
    await room().saveView(boardId, "phone", { x: 3, y: 4, zoom: 1, hideCompleted: true });
    const deletion = { mutationId: crypto.randomUUID() };
    const response = await api("/api/boards/" + boardId, "DELETE", deletion, token);
    const event = (await response.json()) as RoomEvent;
    expect(event.deletedBoardId).toBe(boardId);
    expect(event.board).toBeUndefined();
    expect((await room().snapshot(null, "device")).boards).toHaveLength(0);
    for (const [table, column] of [
      ["boards", "id"],
      ["cards", "board_id"],
      ["device_state", "board_id"],
    ])
      expect(
        await env.DB.prepare("SELECT * FROM " + table + " WHERE " + column + " = ?")
          .bind(boardId)
          .first()
      ).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM mutation_receipts WHERE response LIKE '%erase-board-%'").first()).toBeNull();
    expect(await (await api("/api/boards/" + boardId, "DELETE", deletion, token)).json()).toEqual(event);
    expect((await api("/api/boards/" + boardId + "/restore", "POST", { mutationId: crypto.randomUUID() }, token)).status).toBe(404);
  });
  it("rolls back an entire board deletion when a child delete fails", async () => {
    const { token, boardId } = await setup();
    await mutate(token, boardId, { kind: "create", cardType: "task", id: crypto.randomUUID(), x: 0, y: 0 });
    await room().saveView(boardId, "device", { x: 1, y: 2, zoom: 1, hideCompleted: false });
    const prior = await room().snapshot(boardId, "device");
    const receipts = (await env.DB.prepare("SELECT response FROM mutation_receipts ORDER BY id").all()).results;
    await env.DB.prepare("CREATE TRIGGER fail_delete BEFORE DELETE ON cards BEGIN SELECT RAISE(ABORT, 'forced test failure'); END").run();
    expect((await api("/api/boards/" + boardId, "DELETE", { mutationId: crypto.randomUUID() }, token)).status).toBe(503);
    expect(await room().snapshot(boardId, "device")).toEqual(prior);
    expect((await env.DB.prepare("SELECT response FROM mutation_receipts ORDER BY id").all()).results).toEqual(receipts);
  });
  it("purges legacy soft-deleted rows and receipt content while retaining active cards", async () => {
    const { token, boardId } = await setup();
    await mutate(token, boardId, { kind: "create", cardType: "note", id: crypto.randomUUID(), x: 0, y: 0 });
    const active = (await room().snapshot(boardId, "device")).cards[0];
    await env.DB.prepare("ALTER TABLE boards ADD COLUMN deleted_at INTEGER").run();
    const goneBoard = crypto.randomUUID(),
      goneCard = crypto.randomUUID(),
      child = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO boards (id, name, created_at, deleted_at) VALUES (?, 'legacy-erased-board', 1, 2)").bind(goneBoard).run();
    for (const [id, owner, deletedAt] of [
      [goneCard, boardId, 2],
      [child, goneBoard, null],
    ] as const) {
      const card = { ...active, id, boardId: owner, title: "legacy-erased-content", deletedAt };
      await env.DB.prepare("INSERT INTO cards VALUES (?, ?, ?)").bind(id, owner, JSON.stringify(card)).run();
      await env.DB.prepare("INSERT INTO mutation_receipts VALUES (?, 'legacy', ?, 1)")
        .bind(crypto.randomUUID(), JSON.stringify({ type: "change", seq: 1, card }))
        .run();
    }
    await env.DB.prepare("INSERT INTO device_state VALUES ('legacy-device', ?, '{}', 1)").bind(goneBoard).run();
    expect((await room().snapshot(boardId, "device")).cards.map((card) => card.id)).toEqual([active.id]);
    for (const statement of inject("permanentDeleteMigration")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean))
      await env.DB.prepare(statement).run();
    expect((await env.DB.prepare("SELECT id FROM cards").all<{ id: string }>()).results).toEqual([{ id: active.id }]);
    expect(await env.DB.prepare("SELECT id FROM boards WHERE id = ?").bind(goneBoard).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM mutation_receipts WHERE response LIKE '%legacy-erased%'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT device_id FROM device_state WHERE board_id = ?").bind(goneBoard).first()).toBeNull();
    expect((await env.DB.prepare("PRAGMA table_info(boards)").all<{ name: string }>()).results.some((column) => column.name === "deleted_at")).toBe(false);
    expect((await room().snapshot(boardId, "device")).cards[0]).toEqual(active);
  });
  it("keeps camera and filter state independent between devices", async () => {
    const { boardId } = await setup();
    await room().saveView(boardId, "desktop", { x: 200, y: -400, zoom: 0.7, hideCompleted: true });
    await room().saveView(boardId, "phone", { x: 3, y: 4, zoom: 1.2, hideCompleted: false });
    expect((await room().snapshot(boardId, "desktop")).view.x).toBe(200);
    expect((await room().snapshot(boardId, "phone")).view.zoom).toBe(1.2);
  });
  it("rejects dangerous rich text and invalid geometry", async () => {
    const { token, boardId } = await setup(),
      id = crypto.randomUUID();
    await mutate(token, boardId, { kind: "create", cardType: "note", id, x: 0, y: 0 });
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] };
    expect((await mutate(token, boardId, { kind: "content", id, title: "", description: "", baseVersion: 0, doc })).status).toBe(400);
    expect((await mutate(token, boardId, { kind: "layout", id, width: -10 })).status).toBe(400);
  });
  it("rolls back state and receipt if a D1 transaction fails", async () => {
    const { token, boardId } = await setup();
    await env.DB.prepare("CREATE TRIGGER fail_card BEFORE INSERT ON cards BEGIN SELECT RAISE(ABORT, 'forced test failure'); END").run();
    const response = await mutate(token, boardId, { kind: "create", cardType: "note", id: crypto.randomUUID(), x: 0, y: 0 });
    expect(response.status).toBe(503);
    expect((await room().snapshot(boardId, "device")).seq).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM mutation_receipts").first<{ n: number }>())!.n).toBe(0);
  });
});
describe("realtime", () => {
  it("sends committed changes after hibernation and closes on logout", async () => {
    const { token, boardId } = await setup();
    const response = await worker.fetch(
      new Request(origin + "/api/realtime?boardId=" + boardId, {
        headers: { Cookie: token, Origin: origin, Upgrade: "websocket" },
      }),
      env,
      createExecutionContext()
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const message = () => new Promise<MessageEvent>((resolve) => ws.addEventListener("message", resolve, { once: true }));
    const first = message();
    ws.accept();
    expect(JSON.parse((await first).data as string).type).toBe("snapshot");
    await evictDurableObject(room());
    const next = message();
    const result = await mutate(token, boardId, { kind: "create", id: crypto.randomUUID(), cardType: "note", x: 20, y: 30 });
    const event = JSON.parse((await next).data as string) as RoomEvent;
    expect(event).toEqual(await result.json());
    expect(event.seq).toBe(1);
    await evictDurableObject(room());
    const layoutMessage = message();
    const layoutResponse = await mutate(token, boardId, { kind: "layout.batch", baseSeq: event.seq, positions: [{ id: event.card!.id, x: 0, y: 0 }] });
    const layoutEvent = JSON.parse((await layoutMessage).data as string) as RoomEvent;
    expect(layoutEvent).toEqual(await layoutResponse.json());
    expect(layoutEvent.seq).toBe(2);
    expect(layoutEvent.layout!.positions).toEqual([{ id: event.card!.id, x: 0, y: 0 }]);
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve, { once: true }));
    await api("/api/auth/logout", "POST", {}, token);
    expect((await closed).code).toBe(4001);
  });
});
