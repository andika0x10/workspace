export const SESSION_COOKIE = "workspace_session";
export const DEVICE_COOKIE = "workspace_device";
export const SESSION_AGE = 7 * 24 * 60 * 60;
export const OWNER = "personal";
export function cookie(request: Request, name: string): string | null {
  return (
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1) ?? null
  );
}
export async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function configured(env: Env): boolean {
  return !!env.APP_USERNAME && !!env.APP_PASSWORD && env.AUTH_SECRET?.length >= 32;
}
export function fingerprint(env: Env): Promise<string> {
  return hmac(JSON.stringify([env.APP_USERNAME, env.APP_PASSWORD]), env.AUTH_SECRET);
}
export async function credentialsMatch(username: string, password: string, env: Env): Promise<boolean> {
  const [supplied, expected] = await Promise.all([hash(JSON.stringify([username, password])), hash(JSON.stringify([env.APP_USERNAME, env.APP_PASSWORD]))]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expected));
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(supplied));
}
export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function sessionByHash(tokenHash: string, env: Env) {
  if (!configured(env)) return null;
  const row = await env.DB.prepare("SELECT token_hash, device_id, fingerprint, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, Date.now())
    .first<{ token_hash: string; device_id: string; fingerprint: string; expires_at: number }>();
  return row && row.fingerprint === (await fingerprint(env)) ? row : null;
}
export async function session(request: Request, env: Env) {
  const token = cookie(request, SESSION_COOKIE);
  return token && /^[a-f0-9]{64}$/.test(token) ? sessionByHash(await hash(token), env) : null;
}
export function setCookie(request: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return name + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge + secure;
}
