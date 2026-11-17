import { DurableObject } from "cloudflare:workers";
import { emptyDoc, initialView, mutationSchema, type Board, type Card, type Mutation, type Result, type RoomEvent, type Snapshot, type View } from "../lib/model";
import { configured, credentialsMatch, fingerprint, hash, randomToken, sessionByHash, SESSION_AGE } from "./security";

class SerialObject extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  protected serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
export class LoginGuard extends SerialObject {
  attempt(ipHash: string, username: string, password: string, deviceId: string) {
    return this.serial(async (): Promise<Result<{ token: string; deviceId: string }>> => {
      if (!configured(this.env)) return { ok: false, status: 503, error: "Login belum dikonfigurasi. Hubungi pemilik aplikasi." };
      const now = Date.now(),
        period = 15 * 60 * 1000;
      const prior = await this.env.DB.prepare("SELECT * FROM login_limits WHERE ip_hash = ?")
        .bind(ipHash)
        .first<{ failures: number; window_start: number; blocked_until: number; requests: number; request_window: number }>();
      const state = prior ?? { failures: 0, window_start: now, blocked_until: 0, requests: 0, request_window: now };
      if (now - state.request_window >= 60000) {
        state.requests = 0;
        state.request_window = now;
      }
      state.requests++;
      if (now - state.window_start >= period && state.blocked_until <= now) {
        state.failures = 0;
        state.window_start = now;
      }
      let result: Result<{ token: string; deviceId: string }>;
      let sessionStatement: D1PreparedStatement | undefined;
      if (state.blocked_until > now || state.requests > 30) {
        const until = Math.max(state.blocked_until, state.requests > 30 ? state.request_window + 60000 : 0);
        result = { ok: false, status: 429, error: "Terlalu banyak percobaan. Coba lagi setelah jeda.", retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) };
      } else if (!(await credentialsMatch(username, password, this.env))) {
        state.failures++;
        if (state.failures >= 5) state.blocked_until = now + period;
        result =
          state.blocked_until > now
            ? { ok: false, status: 429, error: "Terlalu banyak percobaan. Coba lagi setelah jeda.", retryAfter: 900 }
            : { ok: false, status: 401, error: "Username atau password tidak sesuai." };
      } else {
        state.failures = 0;
        state.window_start = now;
        state.blocked_until = 0;
        const token = randomToken();
        sessionStatement = this.env.DB.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").bind(
          await hash(token),
          deviceId,
          await fingerprint(this.env),
          now,
          now + SESSION_AGE * 1000
        );
        result = { ok: true, data: { token, deviceId } };
      }
      const statements = [
        this.env.DB.prepare(
          "INSERT INTO login_limits VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ip_hash) DO UPDATE SET failures=excluded.failures, window_start=excluded.window_start, blocked_until=excluded.blocked_until, requests=excluded.requests, request_window=excluded.request_window"
        ).bind(ipHash, state.failures, state.window_start, state.blocked_until, state.requests, state.request_window),
      ];
      if (sessionStatement) statements.push(sessionStatement);
      await this.env.DB.batch(statements);
      return result;
    });
  }
}
// The optional legacy flag supports the rolling upgrade before migration 0002.
type BoardRow = { id: string; name: string; created_at: number; deleted_at?: number | null };
function boardFromRow(row: BoardRow): Board {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}
function cardFromRow(data: string): Card | null {
  const { deletedAt, ...card } = JSON.parse(data) as Card & { deletedAt?: number | null };
  return deletedAt ? null : card;
}
export class WorkspaceRoom extends SerialObject {
  private async bootstrap() {
    const exists = await this.env.DB.prepare("SELECT id FROM workspaces WHERE id = 'personal'").first();
    if (!exists) {
      await this.env.DB.batch([
        this.env.DB.prepare("INSERT INTO workspaces VALUES ('personal', 0)"),
        this.env.DB.prepare("INSERT INTO boards (id, name, created_at) VALUES (?, 'Pribadi', ?)").bind(crypto.randomUUID(), Date.now()),
      ]);
    }
  }
  private async snapshotUnsafe(boardId: string | null, deviceId: string): Promise<Snapshot> {
    await this.bootstrap();
    const boards = (await this.env.DB.prepare("SELECT * FROM boards ORDER BY created_at").all<BoardRow>()).results.filter((row) => !row.deleted_at).map(boardFromRow);
    const last = await this.env.DB.prepare("SELECT board_id FROM device_state WHERE device_id = ? ORDER BY updated_at DESC LIMIT 1").bind(deviceId).first<{ board_id: string }>();
    const current = boards.find((b) => b.id === (boardId ?? last?.board_id)) ?? boards[0];
    const cards = current
      ? (await this.env.DB.prepare("SELECT data FROM cards WHERE board_id = ?").bind(current.id).all<{ data: string }>()).results
          .map((r) => cardFromRow(r.data))
          .filter((c): c is Card => c !== null)
      : [];
    const stored = current
      ? await this.env.DB.prepare("SELECT data FROM device_state WHERE device_id = ? AND board_id = ?").bind(deviceId, current.id).first<{ data: string }>()
      : null;
    const seq = await this.env.DB.prepare("SELECT seq FROM workspaces WHERE id = 'personal'").first<{ seq: number }>();
    return { type: "snapshot", boards, boardId: current?.id ?? null, cards, view: stored ? (JSON.parse(stored.data) as View) : initialView, seq: seq!.seq };
  }
  snapshot(boardId: string | null, deviceId: string) {
    return this.serial(() => this.snapshotUnsafe(boardId, deviceId));
  }
  saveView(boardId: string, deviceId: string, view: View) {
    return this.serial(async () => {
      const board = await this.env.DB.prepare("SELECT * FROM boards WHERE id = ?").bind(boardId).first<BoardRow>();
      if (!board || board.deleted_at) return;
      await this.saveViewUnsafe(boardId, deviceId, view);
    });
  }
  private async saveViewUnsafe(boardId: string, deviceId: string, view: View) {
    await this.env.DB.prepare("INSERT INTO device_state VALUES (?, ?, ?, ?) ON CONFLICT(device_id, board_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
      .bind(deviceId, boardId, JSON.stringify(view), Date.now())
      .run();
  }
  execute(input: Mutation): Promise<Result<RoomEvent>> {
    return this.serial(async () => {
      const parsed = mutationSchema.safeParse(input);
      if (!parsed.success) return { ok: false, status: 400, error: "Perubahan tidak valid." };
      const action = parsed.data,
        now = Date.now(),
        requestHash = await hash(JSON.stringify(action));
      await this.bootstrap();
      const receipt = await this.env.DB.prepare("SELECT request_hash, response FROM mutation_receipts WHERE id = ?")
        .bind(action.mutationId)
        .first<{ request_hash: string; response: string }>();
      if (receipt) {
        if (receipt.request_hash !== requestHash) return { ok: false, status: 409, error: "Identitas perubahan sudah digunakan." };
        const data = JSON.parse(receipt.response) as RoomEvent;
        if ((data.deletedBoardId && action.kind !== "board.delete") || (data.deletedCard && action.kind !== "delete"))
          return { ok: false, status: 410, error: "Data sudah dihapus permanen." };
        return { ok: true, data };
      }
      const priorBoard = await this.env.DB.prepare("SELECT * FROM boards WHERE id = ?").bind(action.boardId).first<BoardRow>();
      if (action.kind !== "board.create" && (!priorBoard || priorBoard.deleted_at)) return { ok: false, status: 404, error: "Board sudah tidak tersedia." };
      const statements: D1PreparedStatement[] = [];
      const seq = (await this.env.DB.prepare("SELECT seq FROM workspaces WHERE id = 'personal'").first<{ seq: number }>())!.seq + 1;
      const event: RoomEvent = { type: "change", seq, mutationId: action.mutationId };
      if (action.kind === "layout.batch") {
        if (action.baseSeq !== seq - 1) return { ok: false, status: 409, error: "Board berubah. Coba Rapikan lagi." };
        const rows = (await this.env.DB.prepare("SELECT data FROM cards WHERE board_id = ?").bind(action.boardId).all<{ data: string }>()).results;
        const cards = new Map(
          rows
            .map((row) => cardFromRow(row.data))
            .filter((card): card is Card => card !== null)
            .map((card) => [card.id, card])
        );
        for (const position of action.positions) {
          if (!cards.has(position.id)) return { ok: false, status: 404, error: "Kartu sudah tidak tersedia. Muat ulang board." };
        }
        event.layout = { boardId: action.boardId, positions: action.positions, updatedAt: now };
        statements.push(
          this.env.DB.prepare(
            "UPDATE cards SET data = json_set(data, '$.x', json_extract(p.value, '$.x'), '$.y', json_extract(p.value, '$.y'), '$.updatedAt', ?) FROM json_each(?) AS p WHERE cards.id = json_extract(p.value, '$.id') AND cards.board_id = ?"
          ).bind(now, JSON.stringify(action.positions), action.boardId)
        );
      } else if (action.kind.startsWith("board.")) {
        if (action.kind === "board.create") {
          if (priorBoard) return { ok: false, status: 409, error: "Board sudah ada." };
          event.board = { id: action.boardId, name: action.name, createdAt: now };
          statements.push(this.env.DB.prepare("INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)").bind(action.boardId, action.name, now));
        } else if (action.kind === "board.delete") {
          event.deletedBoardId = action.boardId;
          statements.push(
            this.env.DB.prepare(
              "UPDATE mutation_receipts SET response = json_object('type', 'change', 'seq', ?, 'mutationId', id, 'deletedBoardId', ?) WHERE COALESCE(json_extract(response, '$.board.id'), json_extract(response, '$.card.boardId'), json_extract(response, '$.layout.boardId'), json_extract(response, '$.deletedBoardId'), json_extract(response, '$.deletedCard.boardId')) = ?"
            ).bind(seq, action.boardId, action.boardId),
            this.env.DB.prepare("DELETE FROM cards WHERE board_id = ?").bind(action.boardId),
            this.env.DB.prepare("DELETE FROM device_state WHERE board_id = ?").bind(action.boardId),
            this.env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(action.boardId)
          );
        } else if (action.kind === "board.rename") {
          event.board = { ...boardFromRow(priorBoard!), name: action.name };
          statements.push(this.env.DB.prepare("UPDATE boards SET name = ? WHERE id = ?").bind(action.name, action.boardId));
        }
      } else {
        if (!("id" in action)) return { ok: false, status: 400, error: "Perubahan tidak valid." };
        const row = await this.env.DB.prepare("SELECT data FROM cards WHERE id = ?").bind(action.id).first<{ data: string }>();
        let card = row ? cardFromRow(row.data) : null;
        if (action.kind === "create") {
          if (card) return { ok: false, status: 409, error: "Kartu sudah ada." };
          card = {
            id: action.id,
            boardId: action.boardId,
            type: action.cardType,
            title: "",
            description: "",
            doc: emptyDoc,
            color: "mint",
            x: action.x,
            y: action.y,
            width: 280,
            z: seq,
            completed: false,
            contentVersion: 0,
            updatedAt: now,
          };
        } else {
          if (!card || card.boardId !== action.boardId) return { ok: false, status: 404, error: "Kartu sudah tidak tersedia." };
          if (action.kind === "content") {
            if (action.baseVersion !== card.contentVersion)
              return { ok: false, status: 409, error: "Kartu ini diubah di perangkat lain. Pilih versi yang ingin digunakan.", current: card };
            card.title = action.title;
            card.description = action.description;
            card.doc = action.doc;
            card.contentVersion++;
          }
          if (action.kind === "layout" && action.front) card.z = seq;
          if (action.kind === "layout")
            for (const key of ["x", "y", "width"] as const) {
              const value = action[key];
              if (value !== undefined) card[key] = value;
            }
          if (action.kind === "complete") card.completed = action.completed;
          if (action.kind === "color") card.color = action.color;
          card.updatedAt = now;
        }
        if (action.kind === "delete") {
          event.deletedCard = { id: card.id, boardId: card.boardId };
          statements.push(
            this.env.DB.prepare(
              "UPDATE mutation_receipts SET response = json_object('type', 'change', 'seq', ?, 'mutationId', id, 'deletedCard', json_object('id', ?, 'boardId', ?)) WHERE COALESCE(json_extract(response, '$.card.id'), json_extract(response, '$.deletedCard.id')) = ?"
            ).bind(seq, card.id, card.boardId, card.id),
            this.env.DB.prepare("DELETE FROM cards WHERE id = ? AND board_id = ?").bind(card.id, card.boardId)
          );
        } else {
          event.card = card;
          statements.push(
            this.env.DB.prepare("INSERT INTO cards VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").bind(card.id, card.boardId, JSON.stringify(card))
          );
        }
      }
      statements.push(
        this.env.DB.prepare("UPDATE workspaces SET seq = ? WHERE id = 'personal'").bind(seq),
        this.env.DB.prepare("INSERT INTO mutation_receipts VALUES (?, ?, ?, ?)").bind(action.mutationId, requestHash, JSON.stringify(event), now)
      );
      await this.env.DB.batch(statements);
      await this.broadcast(event);
      return { ok: true, data: event };
    });
  }
  private async broadcast(event: RoomEvent) {
    const valid = new Map<string, boolean>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { tokenHash: string };
      try {
        if (!valid.has(attachment.tokenHash)) valid.set(attachment.tokenHash, !!(await sessionByHash(attachment.tokenHash, this.env)));
        if (!valid.get(attachment.tokenHash)) {
          ws.close(4001, "Sesi berakhir");
          continue;
        }
        ws.send(JSON.stringify(event));
      } catch {
        try {
          ws.close(1011, "Hubungkan ulang");
        } catch {
          /* already disconnected */
        }
      }
    }
  }
  revokeSession(tokenHash: string) {
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as { tokenHash: string }).tokenHash === tokenHash) ws.close(4001, "Sesi berakhir");
    }
  }
  fetch(request: Request) {
    return this.serial(async () => {
      const tokenHash = request.headers.get("X-Session-Hash") ?? "";
      const auth = await sessionByHash(tokenHash, this.env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ tokenHash, deviceId: auth.device_id });
      const boardId = new URL(request.url).searchParams.get("boardId");
      const snapshot = await this.snapshotUnsafe(boardId, auth.device_id);
      if (snapshot.boardId) await this.saveViewUnsafe(snapshot.boardId, auth.device_id, snapshot.view);
      pair[1].send(JSON.stringify(snapshot));
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }
  async webSocketMessage(ws: WebSocket) {
    // This is a server-push stream. Clients cannot mutate state over the socket.
    const auth = ws.deserializeAttachment() as { tokenHash: string };
    if (!(await sessionByHash(auth.tokenHash, this.env))) ws.close(4001, "Sesi berakhir");
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code, reason);
  }
}
