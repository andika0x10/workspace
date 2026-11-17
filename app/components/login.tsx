"use client";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, request } from "./use-workspace";
import { Brand } from "./brand";

export default function Login({ onLogin, initialError }: { onLogin: () => Promise<void>; initialError: string }) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError),
    [retryAt, setRetryAt] = useState(0),
    [now, setNow] = useState(Date.now());
  useEffect(() => setError(initialError), [initialError]);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || remaining) return;
    setBusy(true);
    setError("");
    try {
      await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      await onLogin();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Belum bisa masuk. Coba lagi.");
      if (issue instanceof ApiError && issue.retryAfter) {
        setRetryAt(Date.now() + issue.retryAfter * 1000);
        setNow(Date.now());
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <header className="login-header">
        <Brand />
      </header>
      <div className="login-main">
        <section className="login-form-wrap">
          <h1>Masuk ke Workspace</h1>
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
            className="login-form"
          >
            <label htmlFor="username">Username</label>
            <input id="username" name="username" autoComplete="username" required maxLength={200} value={username} onChange={(event) => setUsername(event.target.value)} />
            <label htmlFor="password">Password</label>
            <div className="password-field">
              <input
                id="password"
                name="password"
                type={visible ? "text" : "password"}
                autoComplete="current-password"
                required
                maxLength={1000}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button type="button" aria-label={visible ? "Sembunyikan password" : "Tampilkan password"} onClick={() => setVisible((value) => !value)}>
                {visible ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            {error && (
              <div className="form-error" role="alert">
                {error}
                {remaining > 0 && (
                  <span>
                    Coba lagi dalam {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}.
                  </span>
                )}
              </div>
            )}
            <button className="button primary login-submit" disabled={busy || remaining > 0} type="submit">
              {busy ? "Masuk…" : "Masuk"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
