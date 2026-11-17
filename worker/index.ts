import app from "vinext/server/fetch-handler";
import type { WorkspaceRoom, LoginGuard } from "./objects";
import { z } from "zod";
import { mutationSchema, viewSchema } from "../lib/model";
import { configured, cookie, DEVICE_COOKIE, hash, hmac, OWNER, SESSION_AGE, SESSION_COOKIE, session, setCookie } from "./security";
export { WorkspaceRoom, LoginGuard } from "./objects";

function json(data: unknown, status = 200, extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  return Response.json(data, { status, headers });
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new Error("CONTENT_TYPE");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("BODY");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > 80000) {
      await reader.cancel();
      throw new Error("TOO_LARGE");
    }
    chunks.push(item.value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(result));
}
const loginSchema = z.object({ username: z.string().max(200), password: z.string().max(1000) });
async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (((method !== "GET" && method !== "HEAD") || path === "/api/realtime") && request.headers.get("Origin") !== url.origin)
    return json({ error: "Request harus berasal dari aplikasi ini." }, 403);
  if (!configured(env)) return json({ error: "Login belum dikonfigurasi. Atur secrets aplikasi terlebih dahulu." }, 503);
  const room = (env.WORKSPACE as DurableObjectNamespace<WorkspaceRoom>).getByName(OWNER);
  if (path === "/api/auth/login" && method === "POST") {
    const parsed = loginSchema.safeParse(await body(request));
    if (!parsed.success) return json({ error: "Isi username dan password yang valid." }, 400);
    const ip = request.headers.get("CF-Connecting-IP") ?? "local-development";
    const ipHash = await hmac(ip, env.AUTH_SECRET);
    const device = cookie(request, DEVICE_COOKIE);
    const deviceId = device && z.uuid().safeParse(device).success ? device : crypto.randomUUID();
    const result = await (env.LOGIN_GUARD as DurableObjectNamespace<LoginGuard>).getByName(ipHash).attempt(ipHash, parsed.data.username, parsed.data.password, deviceId);
    if (!result.ok) return json(result, result.status, result.retryAfter ? { "Retry-After": String(result.retryAfter) } : undefined);
    const headers = new Headers();
    headers.append("Set-Cookie", setCookie(request, SESSION_COOKIE, result.data.token, SESSION_AGE));
    headers.append("Set-Cookie", setCookie(request, DEVICE_COOKIE, deviceId, 365 * 86400));
    return json({ ok: true }, 200, headers);
  }
  const auth = await session(request, env);
  if (!auth) return json({ error: "Sesi berakhir. Masuk kembali untuk melanjutkan." }, 401);
  if (path === "/api/auth/session" && method === "GET") return json({ username: env.APP_USERNAME, expiresAt: auth.expires_at });
  if (path === "/api/auth/logout" && method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(auth.token_hash).run();
    await room.revokeSession(auth.token_hash);
    return json({ ok: true }, 200, { "Set-Cookie": setCookie(request, SESSION_COOKIE, "", 0) });
  }
  if (path === "/api/realtime" && method === "GET") {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket diperlukan." }, 426);
    const headers = new Headers(request.headers);
    headers.set("X-Session-Hash", auth.token_hash);
    return room.fetch(new Request(request, { headers }));
  }
  if (path === "/api/boards" && method === "GET") return json(await room.snapshot(null, auth.device_id));
  const route = path.match(/^\/api\/boards\/([a-f0-9-]+)(?:\/(mutations|view))?$/);
  const boardId = route?.[1],
    operation = route?.[2];
  if (boardId && !z.uuid().safeParse(boardId).success) return json({ error: "Board tidak valid." }, 400);
  if (boardId && !operation && method === "GET") {
    const snapshot = await room.snapshot(boardId, auth.device_id);
    return snapshot.boardId === boardId ? json(snapshot) : json({ error: "Board sudah tidak tersedia." }, 404);
  }
  if (boardId && operation === "view" && method === "PATCH") {
    const parsed = viewSchema.safeParse(await body(request));
    if (!parsed.success) return json({ error: "Tampilan tidak valid." }, 400);
    await room.saveView(boardId, auth.device_id, parsed.data);
    return json({ ok: true });
  }
  let payload: unknown;
  if (path === "/api/boards" && method === "POST") {
    const value = z.object({ name: z.string(), boardId: z.uuid(), mutationId: z.uuid() }).parse(await body(request));
    payload = { ...value, kind: "board.create" };
  } else if (boardId && !operation && method === "PATCH") {
    const value = z.object({ name: z.string(), mutationId: z.uuid() }).parse(await body(request));
    payload = { ...value, boardId, kind: "board.rename" };
  } else if (boardId && !operation && method === "DELETE") {
    const value = z.object({ mutationId: z.uuid() }).parse(await body(request));
    payload = { ...value, boardId, kind: "board.delete" };
  } else if (boardId && operation === "mutations" && method === "POST") {
    const value = z.record(z.string(), z.unknown()).parse(await body(request));
    if (typeof value.kind !== "string" || value.kind.startsWith("board.")) return json({ error: "Perubahan tidak valid." }, 400);
    payload = { ...value, boardId };
  } else return json({ error: "Halaman tidak ditemukan." }, 404);
  const parsed = mutationSchema.safeParse(payload);
  if (!parsed.success) return json({ error: "Perubahan tidak valid.", issues: parsed.error.issues.map((i) => i.message) }, 400);
  const result = await room.execute(parsed.data);
  return result.ok ? json(result.data) : json(result, result.status);
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) return await api(request, env);
      const response = await app.fetch(request, env, ctx);
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Referrer-Policy", "same-origin");
      response.headers.set("X-Frame-Options", "DENY");
      response.headers.set("Cache-Control", path.startsWith("/assets/") || path.startsWith("/_next/") ? "public, max-age=31536000, immutable" : "no-store");
      return response;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError || (error instanceof Error && ["CONTENT_TYPE", "BODY"].includes(error.message)))
        return json({ error: "Request tidak valid." }, 400);
      if (error instanceof Error && error.message === "TOO_LARGE") return json({ error: "Konten terlalu besar." }, 413);
      console.error(JSON.stringify({ event: "request_failed", path: new URL(request.url).pathname, errorType: error instanceof Error ? error.name : "Unknown" }));
      return json({ error: "Penyimpanan sedang tidak tersedia. Coba lagi; perubahan belum tersimpan." }, 503);
    }
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()),
      env.DB.prepare("DELETE FROM login_limits WHERE blocked_until < ? AND request_window < ?").bind(Date.now(), Date.now() - 86400000),
    ]);
  },
} satisfies ExportedHandler<Env>;
