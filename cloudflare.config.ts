import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";
export default defineConfig(({ mode }) => ({
  accountId: "3733a7977c6783973d0ee237b086aa34",
  worker: defineWorker({
    name: "workspace",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-11-16",
    compatibilityFlags: ["nodejs_compat"],
    exports: {
      WorkspaceRoom: exports.durableObject({ storage: "sqlite" }),
      LoginGuard: exports.durableObject({ storage: "sqlite" }),
    },
    triggers: [triggers.scheduled({ schedule: "0 3 * * *" })],
    observability: { enabled: true, traces: { enabled: true, headSamplingRate: 0.1 } },
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),
      DB: bindings.d1(
        mode === "development" || mode === "test"
          ? { name: "workspace-local", id: "00000000-0000-4000-8000-000000000001" }
          : { name: "workspace-production", id: "e88f12e8-6bb8-4de8-838e-590a054b93dc" }
      ),
      WORKSPACE: bindings.durableObject({ worker: "workspace", exportName: "WorkspaceRoom" }),
      LOGIN_GUARD: bindings.durableObject({ worker: "workspace", exportName: "LoginGuard" }),
      APP_USERNAME: bindings.secret(),
      APP_PASSWORD: bindings.secret(),
      AUTH_SECRET: bindings.secret(),
    },
  }),
}));
