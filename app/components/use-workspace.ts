"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { initialView, type Mutation, type MutationInput, type RoomEvent, type Snapshot, type View, type Card } from "../../lib/model";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public current?: Card,
    public retryAfter?: number
  ) {
    super(message);
  }
}
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers }, cache: "no-store" });
  } catch {
    throw new ApiError("Koneksi terputus. Perubahan belum tersimpan.", 0);
  }
  const value = (await response.json()) as T & { error?: string; current?: Card; retryAfter?: number };
  if (!response.ok)
    throw new ApiError(
      value.error ?? "Terjadi kesalahan. Coba lagi.",
      response.status,
      value.current,
      value.retryAfter ?? (Number(response.headers.get("Retry-After")) || undefined)
    );
  return value;
}
export type Toast = { text: string; action?: string; run?: () => void };
export function useWorkspace() {
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  const [username, setUsername] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [saving, setSaving] = useState(0);
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [initialError, setInitialError] = useState("");
  const boardRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<() => void>(() => {});
  const viewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingView = useRef<{ boardId: string; view: View } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const notify = useCallback((next: Toast) => {
    clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = setTimeout(() => setToast(null), next.action ? 15000 : 6500);
  }, []);
  const applyEvent = useCallback((event: RoomEvent) => {
    if (event.seq <= seqRef.current) return;
    if (event.seq > seqRef.current + 1) {
      reconnectRef.current();
      return;
    }
    seqRef.current = event.seq;
    setSnapshot((state) => {
      if (!state) return state;
      let boards = state.boards,
        cards = state.cards;
      if (event.board) boards = [...boards.filter((b) => b.id !== event.board!.id), event.board].sort((a, b) => a.createdAt - b.createdAt);
      if (event.card && event.card.boardId === state.boardId) cards = [...cards.filter((c) => c.id !== event.card!.id), event.card];
      if (event.layout?.boardId === state.boardId) {
        const positions = new Map(event.layout.positions.map((position) => [position.id, position]));
        cards = cards.map((card) => {
          const position = positions.get(card.id);
          return position ? { ...card, x: position.x, y: position.y, updatedAt: event.layout!.updatedAt } : card;
        });
      }
      if (event.deletedCard?.boardId === state.boardId) cards = cards.filter((card) => card.id !== event.deletedCard!.id);
      if (event.deletedBoardId) {
        boards = boards.filter((board) => board.id !== event.deletedBoardId);
        if (event.deletedBoardId === state.boardId) cards = [];
      }
      return { ...state, seq: event.seq, boards, cards };
    });
  }, []);
  const authenticated = useCallback(async () => {
    setInitialError("");
    try {
      const session = await request<{ username: string }>("/api/auth/session");
      setUsername(session.username);
      const data = await request<Snapshot>("/api/boards");
      boardRef.current = data.boardId;
      seqRef.current = data.seq;
      setSnapshot(data);
      setAuth("in");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuth("out");
      else {
        setInitialError(error instanceof Error ? error.message : "Aplikasi belum bisa dibuka.");
        setAuth("out");
      }
    }
  }, []);
  useEffect(() => {
    void authenticated();
    return () => {
      clearTimeout(toastTimer.current);
      clearTimeout(viewTimer.current);
    };
  }, [authenticated]);
  useEffect(() => {
    if (auth !== "in") return;
    let stopped = false,
      retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      if (stopped) return;
      socketRef.current?.close(1000);
      const url = new URL("/api/realtime", window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (boardRef.current) url.searchParams.set("boardId", boardRef.current);
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        retry = 0;
      };
      socket.onmessage = (message) => {
        if (socketRef.current !== socket) return;
        const event = JSON.parse(message.data as string) as Snapshot | RoomEvent;
        if (event.type === "snapshot") {
          seqRef.current = event.seq;
          boardRef.current = event.boardId;
          setSnapshot(event);
          setConnected(true);
          if (pendingView.current?.boardId === event.boardId) void flushView();
        } else applyEvent(event);
      };
      socket.onclose = (event) => {
        if (stopped || socketRef.current !== socket) return;
        setConnected(false);
        if (event.code === 4001) {
          setAuth("out");
          setSnapshot(null);
          setInitialError("Sesi berakhir. Masuk kembali untuk melanjutkan.");
          return;
        }
        timer = setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
      };
      socket.onerror = () => socket.close();
    };
    reconnectRef.current = () => {
      clearTimeout(timer);
      connect();
    };
    const online = () => reconnectRef.current();
    const offline = () => {
      setConnected(false);
      socketRef.current?.close();
    };
    connect();
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      stopped = true;
      clearTimeout(timer);
      socketRef.current?.close();
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
    // flushView reads the current pending view through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, applyEvent]);
  const switchBoard = useCallback(async (id: string | null) => {
    await flushView();
    boardRef.current = id;
    setConnected(false);
    reconnectRef.current();
  }, []);
  const refresh = useCallback(() => {
    setConnected(false);
    reconnectRef.current();
  }, []);
  const mutate = useCallback(
    async (input: MutationInput, mutationId = crypto.randomUUID()): Promise<RoomEvent> => {
      const action = { ...input, mutationId } as Mutation;
      let path = "/api/boards/" + action.boardId,
        method = "POST";
      if (action.kind === "board.create") path = "/api/boards";
      else if (action.kind === "board.rename") method = "PATCH";
      else if (action.kind === "board.delete") method = "DELETE";
      else path += "/mutations";
      setSaving((n) => n + 1);
      try {
        let response: RoomEvent | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            response = await request<RoomEvent>(path, { method, body: JSON.stringify(action) });
            break;
          } catch (error) {
            if (!(error instanceof ApiError) || ![0, 503].includes(error.status) || attempt === 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
          }
        }
        setFailed(false);
        applyEvent(response!);
        return response!;
      } catch (error) {
        setFailed(true);
        if (error instanceof ApiError && error.status === 401) {
          setAuth("out");
          setSnapshot(null);
        }
        if (error instanceof ApiError && [0, 503].includes(error.status)) {
          setConnected(false);
          socketRef.current?.close();
        }
        throw error;
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [applyEvent]
  );
  const perform = useCallback(
    async (input: MutationInput, success?: string) => {
      const mutationId = crypto.randomUUID();
      const run = async () => {
        try {
          const event = await mutate(input, mutationId);
          if (success) notify({ text: success });
          return event;
        } catch (error) {
          notify({
            text: error instanceof Error ? error.message : "Perubahan belum tersimpan.",
            action: "Coba lagi",
            run: () => {
              void run();
            },
          });
        }
      };
      return run();
    },
    [mutate, notify]
  );
  async function flushView() {
    clearTimeout(viewTimer.current);
    const pending = pendingView.current;
    if (!pending) return;
    try {
      await request("/api/boards/" + pending.boardId + "/view", { method: "PATCH", body: JSON.stringify(pending.view) });
      if (pendingView.current === pending) pendingView.current = null;
    } catch {
      /* Retain it in memory and retry after reconnect. */
    }
  }
  const saveView = useCallback((boardId: string, view: View) => {
    pendingView.current = { boardId, view };
    setSnapshot((state) => (state?.boardId === boardId ? { ...state, view } : state));
    clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => {
      void flushView();
    }, 650);
  }, []);
  const logout = useCallback(async () => {
    await flushView();
    try {
      await request("/api/auth/logout", { method: "POST", body: "{}" });
      setAuth("out");
      setSnapshot(null);
      setUsername("");
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : "Belum bisa keluar. Coba lagi." });
    }
  }, [notify]);
  return { auth, username, snapshot, connected, saving, failed, toast, setToast, initialError, authenticated, switchBoard, refresh, mutate, perform, notify, saveView, logout };
}
