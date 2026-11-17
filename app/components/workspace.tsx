"use client";
import { lazy, Suspense } from "react";
import { LoaderCircle, X } from "lucide-react";
import Login from "./login";
import { Brand } from "./brand";
import { useWorkspace } from "./use-workspace";
const Canvas = lazy(() => import("./canvas"));
function Loading() {
  return (
    <div className="app-loading">
      <Brand />
      <LoaderCircle size={22} className="spin" />
      <span>Membuka ruangmu…</span>
    </div>
  );
}
export default function Workspace() {
  const engine = useWorkspace();
  if (engine.auth === "loading") return <Loading />;
  return (
    <>
      {engine.auth === "out" ? (
        <Login onLogin={engine.authenticated} initialError={engine.initialError} />
      ) : (
        engine.snapshot && (
          <Suspense fallback={<Loading />}>
            <Canvas engine={engine} />
          </Suspense>
        )
      )}
      {engine.toast && (
        <div className="toast" role="status">
          <span>{engine.toast.text}</span>
          {engine.toast.run && (
            <button
              onClick={() => {
                const run = engine.toast?.run;
                engine.setToast(null);
                run?.();
              }}
            >
              {engine.toast.action}
            </button>
          )}
          <button className="toast-dismiss" aria-label="Tutup notifikasi" onClick={() => engine.setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}
