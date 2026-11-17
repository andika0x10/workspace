"use client";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  ViewportPortal,
  useViewport,
  useReactFlow,
  useNodesState,
  getViewportForBounds,
  type Node,
  type NodeProps,
  type NodeChange,
  NodeChangeset,
  NodeResizeControl,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Check,
  ChevronDown,
  ListFilter,
  LoaderCircle,
  Grid2X2,
  Minus,
  MoreHorizontal,
  MoveUpRight,
  Plus,
  Search,
  Trash2,
  WifiOff,
  X,
  MousePointer2,
  SquarePlus,
} from "lucide-react";
import { cardDocument, textContent, type Board, type Card, type CardPosition, type View } from "../../lib/model";
import { findCardSpace, tidyCards, type CardRect } from "../../lib/layout";
import { ApiError } from "./use-workspace";
import { RichText } from "./rich-text";
import { BrandMark } from "./brand";
import type { useWorkspace } from "./use-workspace";
const CardEditor = lazy(() => import("./editor"));
type Engine = ReturnType<typeof useWorkspace>;
type CardData = {
  card: Card;
  editing: boolean;
  mobile: boolean;
  connected: boolean;
  onEdit: (id: string | null) => void;
  onDirty: (dirty: boolean) => void;
  perform: Engine["perform"];
  mutate: Engine["mutate"];
  onResize: (id: string, width: number) => void;
};
type CardNodeType = Node<CardData, "card">;
function CardPreview({ card }: { card: Card }) {
  return (
    <>
      <h2 className={!card.title ? "placeholder" : ""}>{card.title || (card.type === "note" ? "Note baru" : "Task baru")}</h2>
      {card.type === "note" ? (
        <div className="note-preview note-prose">{textContent(card.doc).trim() ? <RichText node={card.doc} /> : null}</div>
      ) : card.description ? (
        <div className="note-preview task-preview note-prose">
          <RichText node={cardDocument(card)} />
        </div>
      ) : null}
    </>
  );
}
const CardNode = memo(function CardNode({ data, selected }: NodeProps<CardNodeType>) {
  const { card, editing, mobile, connected, onEdit, onDirty, perform, mutate } = data;
  const [menu, setMenu] = useState(false);
  const [pending, setPending] = useState<boolean | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setPending(null);
  }, [card.completed]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as HTMLElement)) setMenu(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  const completed = pending ?? card.completed;
  return (
    <article
      className={
        "canvas-card " +
        (card.type === "note" ? "note-card " + card.color : "task-card") +
        (selected ? " selected" : "") +
        (mobile ? " mobile-card" : "") +
        (completed && card.type === "task" ? " completed" : "") +
        (editing ? " editing" : "")
      }
      data-testid={"card-" + card.type}
    >
      <div className="card-header">
        <span className={"card-kind" + (card.type === "task" ? " task-status" : "")}>{card.type === "note" ? "Note" : completed ? "Selesai" : "Belum selesai"}</span>
        <span className="card-drag-handle" title="Geser untuk memindahkan kartu" aria-label="Pegangan pindah kartu" />
        {card.type === "task" && (
          <button
            className="task-check nodrag nopan"
            aria-label={completed ? "Tandai belum selesai" : "Selesaikan task"}
            aria-pressed={completed}
            disabled={!connected}
            onClick={() => {
              setPending(!completed);
              void perform({ kind: "complete", boardId: card.boardId, id: card.id, completed: !completed }).then((result) => {
                if (!result) setPending(null);
              });
            }}
          >
            {completed && <Check size={12} strokeWidth={2.4} />}
          </button>
        )}
        <div className="card-options nodrag nopan" ref={menuRef}>
          <button className="icon-button small" aria-label="Menu kartu" aria-expanded={menu} onClick={() => setMenu((value) => !value)}>
            <MoreHorizontal size={17} />
          </button>
          {menu && (
            <div className="popover card-menu">
              <button
                className="danger"
                disabled={!connected}
                onClick={() => {
                  void perform({ kind: "delete", id: card.id, boardId: card.boardId }, "Kartu dihapus permanen.");
                  setMenu(false);
                }}
              >
                <Trash2 size={14} /> Hapus kartu
              </button>
            </div>
          )}
        </div>
      </div>
      {editing && !mobile ? (
        <Suspense
          fallback={
            <div className="editor-loading">
              <LoaderCircle className="spin" size={18} /> Membuka editor…
            </div>
          }
        >
          <CardEditor card={card} connected={connected} mutate={mutate} onDirty={onDirty} onClose={() => onEdit(null)} />
        </Suspense>
      ) : (
        <div className="card-body">
          <div
            className={"card-content" + (mobile ? "" : " nodrag")}
            role="button"
            tabIndex={0}
            aria-label={"Edit " + (card.title || (card.type === "note" ? "note" : "task"))}
            onClick={(event) => {
              if (!(event.target as HTMLElement).closest("a")) onEdit(card.id);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.stopPropagation();
                onEdit(card.id);
              }
            }}
          >
            <CardPreview card={card} />
          </div>
        </div>
      )}
      {selected && !mobile && !editing && (
        <NodeResizeControl
          position="right"
          resizeDirection="horizontal"
          minWidth={240}
          maxWidth={560}
          onResizeEnd={(_event, parameters) => data.onResize(card.id, Math.round(parameters.width))}
          className="resize-control"
        >
          <span />
        </NodeResizeControl>
      )}
    </article>
  );
});
const nodeTypes = { card: CardNode };
function CanvasGuides() {
  const { zoom } = useViewport();
  const gap = zoom < 0.25 ? 96 : zoom < 0.5 ? 48 : 24;
  return (
    <>
      <Background id="canvas-dots" variant={BackgroundVariant.Dots} gap={gap} size={0.7 / zoom} color="#dce0e5" bgColor="#fff" />
      <ViewportPortal>
        <span className="canvas-origin" aria-hidden="true" style={{ transform: `scale(${1 / zoom})` }}>
          <svg width="18" height="18" viewBox="0 0 18 18" focusable="false">
            <circle cx="9" cy="9" r="6" fill="white" stroke="currentColor" strokeWidth="0.8" />
            <circle cx="9" cy="9" r="1.75" fill="currentColor" />
          </svg>
        </span>
      </ViewportPortal>
    </>
  );
}
function motion(duration: number) {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration;
}
function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={"modal " + className}>
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && <Dialog.Description>{description}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <button className="icon-button" aria-label="Tutup">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          {!description && <Dialog.Description className="sr-only">{title}</Dialog.Description>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function BoardForm({ board, onSubmit, onCancel }: { board?: Board; onSubmit: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(board?.name ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onSubmit(name.trim())
          .catch((issue) => setError(issue instanceof Error ? issue.message : "Board belum tersimpan."))
          .finally(() => setBusy(false));
      }}
    >
      <label className="field-label" htmlFor="board-name">
        Nama board
      </label>
      <input
        id="board-name"
        className="form-input"
        autoFocus
        required
        maxLength={80}
        placeholder="Misalnya: Proyek berikutnya"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button secondary" type="button" onClick={onCancel}>
          Batal
        </button>
        <button className="button primary" disabled={busy || !name.trim()}>
          {busy ? "Menyimpan…" : board ? "Simpan nama" : "Buat board"}
        </button>
      </div>
    </form>
  );
}
function Canvas({ engine }: { engine: Engine }) {
  const { snapshot, connected, perform, mutate, notify, switchBoard, saveView } = engine;
  const board = snapshot!.boards.find((value) => value.id === snapshot!.boardId);
  const [nodes, setNodes, applyNodeChanges] = useNodesState<CardNodeType>([]);
  const pendingDimensions = useRef(new Map<string, NodeChange<CardNodeType>>());
  const measurementFrame = useRef<number | null>(null);
  const onNodesChange = useCallback(
    (changes: NodeChangeset<CardNodeType>) => {
      const immediate: NodeChange<CardNodeType>[] = [];
      for (const change of changes) {
        if (change.type === "dimensions" && change.resizing === undefined) pendingDimensions.current.set(change.id, change);
        else immediate.push(change);
      }
      if (immediate.length) applyNodeChanges(new NodeChangeset(immediate));
      // ResizeObserver measurements must not resize the observed DOM in the same delivery cycle.
      if (pendingDimensions.current.size && measurementFrame.current === null)
        measurementFrame.current = requestAnimationFrame(() => {
          measurementFrame.current = null;
          const buffered = [...pendingDimensions.current.values()];
          pendingDimensions.current.clear();
          applyNodeChanges(new NodeChangeset(buffered));
        });
    },
    [applyNodeChanges]
  );
  useEffect(
    () => () => {
      if (measurementFrame.current !== null) cancelAnimationFrame(measurementFrame.current);
    },
    []
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const [boardMenu, setBoardMenu] = useState(false),
    [accountMenu, setAccountMenu] = useState(false);
  const [boardModal, setBoardModal] = useState<"create" | "rename" | "delete" | null>(null);
  const boardRequest = useRef<{ kind: "board.create" | "board.rename"; name: string; boardId: string; mutationId: string } | null>(null);
  const [search, setSearch] = useState(false),
    [query, setQuery] = useState("");
  const [addMenu, setAddMenu] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [hasDraft, setHasDraft] = useState(false);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const operation = useRef(false);
  const measurementRoot = useRef<HTMLDivElement>(null);
  const latest = useRef({ snapshot: snapshot!, connected });
  latest.current = { snapshot: snapshot!, connected };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  type UndoLayout = { boardId: string; seq: number; expiresAt: number; positions: CardPosition[]; view: View };
  const undo = useRef<UndoLayout | null>(null);
  useEffect(() => {
    if (undo.current && (!connected || undo.current.boardId !== snapshot!.boardId || undo.current.seq !== snapshot!.seq)) {
      undo.current = null;
      engine.setToast((toast) => (toast?.action === "Urungkan" ? { text: toast.text } : toast));
    }
  }, [connected, snapshot!.boardId, snapshot!.seq, engine.setToast]);
  const [visualViewport, setVisualViewport] = useState<{ height: number; bottom: number } | null>(null);
  const dirty = useRef(false);
  const dragging = useRef<string | null>(null);
  const pendingPositions = useRef(new Map<string, { x: number; y: number }>());
  const menuRef = useRef<HTMLDivElement>(null),
    accountRef = useRef<HTMLDivElement>(null);
  const currentBoard = useRef<string | null | undefined>(undefined);
  const flow = useReactFlow<CardNodeType>();
  const view = snapshot!.view;
  const editorCard = snapshot!.cards.find((card) => card.id === editing);
  const cards = snapshot!.cards;
  const visible = useMemo(() => cards.filter((card) => !view.hideCompleted || card.type !== "task" || !card.completed), [cards, view.hideCompleted]);
  const onDirty = useCallback((value: boolean) => {
    dirty.current = value;
    setHasDraft(value);
  }, []);
  const onEdit = useCallback(
    (id: string | null) => {
      if (operation.current) return;
      if (dirty.current) {
        notify({ text: "Selesaikan atau simpan edit yang terbuka terlebih dahulu." });
        return;
      }
      setEditing(id);
    },
    [notify]
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => {
      if (!dirty.current) setMobile(media.matches);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!hasDraft) setMobile(window.matchMedia("(max-width: 640px)").matches);
  }, [hasDraft]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setVisualViewport({ height: viewport.height, bottom: Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) });
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as HTMLElement)) setBoardMenu(false);
      if (!accountRef.current?.contains(event.target as HTMLElement)) setAccountMenu(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);
  useEffect(() => {
    if (currentBoard.current !== snapshot!.boardId) {
      currentBoard.current = snapshot!.boardId;
      setEditing(null);
      dirty.current = false;
      void flow.setViewport({ x: view.x, y: view.y, zoom: view.zoom });
      setZoom(view.zoom);
    }
    setNodes((previous) => {
      const previousById = new Map(previous.map((node) => [node.id, node]));
      const renderCards = [...visible];
      const held = editing ? previousById.get(editing) : undefined;
      if (hasDraft && held && !renderCards.some((card) => card.id === editing)) renderCards.push(held.data.card);
      return renderCards.map((card) => {
        const existing = previousById.get(card.id);
        const pending = pendingPositions.current.get(card.id);
        if (pending && pending.x === card.x && pending.y === card.y) pendingPositions.current.delete(card.id);
        const position = dragging.current === card.id && existing ? existing.position : (pending ?? { x: card.x, y: card.y });
        const sameData =
          existing &&
          existing.data.card === card &&
          existing.data.editing === (editing === card.id) &&
          existing.data.mobile === mobile &&
          existing.data.connected === (connected && !layoutBusy);
        if (sameData && existing.position.x === position.x && existing.position.y === position.y && existing.style?.width === card.width && existing.zIndex === card.z)
          return existing;
        return {
          ...existing,
          id: card.id,
          type: "card",
          position,
          style: { width: card.width },
          zIndex: card.z,
          selected: existing?.selected ?? false,
          dragHandle: mobile ? undefined : ".card-drag-handle",
          data: sameData
            ? existing.data
            : {
                card,
                editing: editing === card.id,
                mobile,
                connected: connected && !layoutBusy,
                onEdit,
                onDirty,
                perform,
                mutate,
                onResize: (id, width) => {
                  void perform({ kind: "layout", id, boardId: card.boardId, width });
                },
              },
        };
      });
    });
  }, [visible, editing, hasDraft, mobile, connected, layoutBusy, onEdit, onDirty, perform, mutate, setNodes, snapshot!.boardId, flow, view.x, view.y, view.zoom]);
  useEffect(() => {
    if (snapshot!.boardId && !board && !hasDraft) void switchBoard(null);
  }, [snapshot!.boardId, board, hasDraft, switchBoard]);
  const displayedEditor = editorCard;
  const seenEditor = useRef<string | null>(null);
  useEffect(() => {
    if (editorCard) {
      seenEditor.current = editorCard.id;
      return;
    }
    if (editing && seenEditor.current === editing && connected) {
      dirty.current = false;
      setHasDraft(false);
      setEditing(null);
      notify({ text: "Kartu sudah dihapus permanen." });
    }
    if (!editing) seenEditor.current = null;
  }, [editorCard, editing, connected, notify]);
  const navigate = async (id: string | null) => {
    if (operation.current) return;
    if (dirty.current) {
      notify({ text: "Simpan atau selesaikan edit sebelum berpindah board." });
      return;
    }
    setBoardMenu(false);
    await switchBoard(id);
  };
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const measureCards = async (): Promise<CardRect[]> => {
    await document.fonts.ready;
    await frame();
    await frame();
    if (!mounted.current || !measurementRoot.current) throw new Error("Pengukuran kartu dibatalkan.");
    const heights = new Map(
      [...measurementRoot.current.querySelectorAll<HTMLElement>("[data-measure-id]")].map((element) => [
        element.dataset.measureId!,
        Math.ceil(element.getBoundingClientRect().height),
      ])
    );
    return cards.map((card) => {
      const height = heights.get(card.id);
      if (!height) throw new Error("Ukuran kartu belum tersedia. Coba lagi.");
      return { id: card.id, x: card.x, y: card.y, width: card.width, height };
    });
  };
  const stillCurrent = (boardId: string, seq: number) =>
    mounted.current && latest.current.connected && latest.current.snapshot.boardId === boardId && latest.current.snapshot.seq === seq;
  const layoutError = (error: unknown) => {
    if (!mounted.current) return;
    if (error instanceof ApiError && [404, 409].includes(error.status)) engine.refresh();
    notify({ text: error instanceof Error ? error.message : "Posisi kartu belum tersimpan. Coba lagi." });
  };
  const finishLayout = () => {
    operation.current = false;
    if (mounted.current) setLayoutBusy(false);
  };
  const undoLayout = async (previous: UndoLayout) => {
    if (operation.current || undo.current !== previous || Date.now() >= previous.expiresAt || !stillCurrent(previous.boardId, previous.seq)) return;
    undo.current = null;
    operation.current = true;
    setLayoutBusy(true);
    try {
      const event = await mutate({ kind: "layout.batch", boardId: previous.boardId, baseSeq: previous.seq, positions: previous.positions });
      await frame();
      if (stillCurrent(previous.boardId, event.seq)) {
        await flow.setViewport(previous.view, { duration: motion(220) });
        saveView(previous.boardId, previous.view);
        notify({ text: "Susunan sebelumnya dikembalikan." });
      }
    } catch (error) {
      layoutError(error);
    } finally {
      finishLayout();
    }
  };
  const tidy = async () => {
    if (!board || !connected || !cards.length || editing || engine.saving || operation.current) return;
    const boardId = board.id,
      baseSeq = snapshot!.seq;
    const previousView = { ...flow.getViewport(), hideCompleted: view.hideCompleted };
    operation.current = true;
    setLayoutBusy(true);
    setAddMenu(false);
    try {
      const measured = await measureCards();
      if (!stillCurrent(boardId, baseSeq)) throw new Error("Board berubah. Coba Rapikan lagi.");
      const positions = tidyCards(measured);
      const event = await mutate({ kind: "layout.batch", boardId, baseSeq, positions });
      await frame();
      if (!stillCurrent(boardId, event.seq)) return;
      const shown = new Set(visible.map((card) => card.id));
      const positionById = new Map(positions.map((position) => [position.id, position]));
      const positioned = measured.map((card) => ({ ...card, ...positionById.get(card.id)! })).filter((card) => shown.has(card.id));
      if (positioned.length) {
        const canvas = document.querySelector(".canvas-surface")!.getBoundingClientRect();
        const x = Math.min(...positioned.map((card) => card.x)),
          y = Math.min(...positioned.map((card) => card.y));
        const width = Math.max(...positioned.map((card) => card.x + card.width)) - x;
        const height = Math.max(...positioned.map((card) => card.y + card.height)) - y;
        await flow.setViewport(getViewportForBounds({ x, y, width, height }, canvas.width, canvas.height, 0.15, 1, { x: "8%", top: "8%", bottom: 112 }), { duration: motion(220) });
      }
      if (!stillCurrent(boardId, event.seq)) return;
      const previous: UndoLayout = { boardId, seq: event.seq, expiresAt: Date.now() + 15000, positions: cards.map(({ id, x, y }) => ({ id, x, y })), view: previousView };
      undo.current = previous;
      notify({
        text: "Kartu dirapikan",
        action: "Urungkan",
        run: () => {
          void undoLayout(previous);
        },
      });
    } catch (error) {
      layoutError(error);
    } finally {
      finishLayout();
    }
  };
  const add = async (type: "note" | "task") => {
    if (!board || !connected || engine.saving || operation.current) return;
    if (dirty.current) {
      notify({ text: "Selesaikan edit yang terbuka terlebih dahulu." });
      return;
    }
    const boardId = board.id,
      baseSeq = snapshot!.seq;
    operation.current = true;
    setLayoutBusy(true);
    setAddMenu(false);
    try {
      const measured = await measureCards();
      if (!stillCurrent(boardId, baseSeq)) throw new Error("Board berubah. Coba tambahkan kartu lagi.");
      const canvas = document.querySelector(".canvas-surface")!.getBoundingClientRect();
      const center = flow.screenToFlowPosition({ x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 });
      const distance = (card: CardRect) => (card.x + card.width / 2 - center.x) ** 2 + (card.y + card.height / 2 - center.y) ** 2;
      const anchor = measured.find((card) => nodes.some((node) => node.id === card.id && node.selected)) ?? [...measured].sort((a, b) => distance(a) - distance(b))[0];
      const target = anchor ? { x: anchor.x + anchor.width / 2 - 140, y: anchor.y + anchor.height / 2 - 114 } : { x: center.x - 140, y: center.y - 114 };
      const position = findCardSpace(measured, target);
      const id = crypto.randomUUID();
      const result = await perform({ kind: "create", cardType: type, id, boardId, ...position });
      if (result && mounted.current && latest.current.snapshot.boardId === boardId) {
        // A previously selected node is elevated by React Flow and can cover the new editor.
        setNodes((current) => current.map((node) => (node.selected ? { ...node, selected: false } : node)));
        setEditing(id);
        await flow.setCenter(position.x + 140, position.y + 114, { zoom: Math.min(flow.getZoom(), 1), duration: motion(120) });
      }
    } catch (error) {
      layoutError(error);
    } finally {
      finishLayout();
    }
  };
  const selectedCard = nodes.find((node) => node.selected)?.data.card;
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea,[contenteditable=true],[role=dialog]")) return;
      if (operation.current) return;
      if (target.classList.contains("react-flow__node") && connected && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        const node = flow.getNode(target.getAttribute("data-id") ?? "");
        if (node) {
          event.preventDefault();
          event.stopPropagation();
          const step = event.shiftKey ? 50 : 10;
          const x = node.position.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0);
          const y = node.position.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0);
          pendingPositions.current.set(node.id, { x, y });
          setNodes((previous) => previous.map((item) => (item.id === node.id ? { ...item, position: { x, y } } : item)));
          void perform({ kind: "layout", id: node.id, boardId: node.data.card.boardId, x, y, front: true }).then((result) => {
            pendingPositions.current.delete(node.id);
            if (!result) setNodes((previous) => previous.map((item) => (item.id === node.id ? { ...item, position: node.position } : item)));
          });
          return;
        }
      }
      if (event.key === "/" || ((event.ctrlKey || event.metaKey) && event.key === "k")) {
        event.preventDefault();
        setSearch(true);
      }
      if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        void add("note");
      }
      if (event.key.toLowerCase() === "t" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        void add("task");
      }
      if (event.key === "Escape") {
        setAddMenu(false);
        setBoardMenu(false);
        onEdit(null);
      }
      if (event.key === "Delete" && selectedCard && connected && !editing) {
        event.preventDefault();
        void perform({ kind: "delete", boardId: selectedCard.boardId, id: selectedCard.id }, "Kartu dihapus permanen.");
      }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => window.removeEventListener("keydown", keyboard, true);
  });
  const rememberCamera = (viewport: { x: number; y: number; zoom: number }) => {
    setZoom(viewport.zoom);
    if (board && connected) saveView(board.id, { ...viewport, hideCompleted: view.hideCompleted });
  };
  const results = cards.filter((card) => (card.title + " " + card.description + " " + textContent(card.doc)).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <div className="board-selector-wrap" ref={menuRef}>
          <button className="board-selector" aria-label="Pilih board" aria-expanded={boardMenu} onClick={() => setBoardMenu((value) => !value)}>
            <BrandMark />
            {board?.name ?? "Pilih board"}
            <ChevronDown size={13} />
          </button>
          {boardMenu && (
            <div className="popover board-menu">
              {snapshot!.boards.map((item) => (
                <button
                  key={item.id}
                  aria-current={item.id === board?.id ? "page" : undefined}
                  onClick={() => {
                    void navigate(item.id);
                  }}
                >
                  {item.name}
                </button>
              ))}
              <div className="menu-divider" />
              <button
                disabled={!connected}
                onClick={() => {
                  setBoardModal("create");
                  setBoardMenu(false);
                }}
              >
                Buat board
              </button>
              {board && (
                <>
                  <button
                    disabled={!connected}
                    onClick={() => {
                      setBoardModal("rename");
                      setBoardMenu(false);
                    }}
                  >
                    Ubah nama
                  </button>
                  <button
                    className="danger"
                    disabled={!connected}
                    onClick={() => {
                      setBoardModal("delete");
                      setBoardMenu(false);
                    }}
                  >
                    Hapus board
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="header-actions">
          <span className={"sync-status" + (connected && !engine.saving && !engine.failed ? " is-idle" : "")} aria-live="polite">
            {!connected ? "Menghubungkan…" : engine.saving ? "Menyimpan…" : engine.failed ? "Belum tersimpan" : "Tersinkron"}
          </span>
          <button
            className="icon-button filter-toggle"
            disabled={!connected || !board}
            aria-label={view.hideCompleted ? "Tampilkan task selesai" : "Sembunyikan task selesai"}
            aria-pressed={view.hideCompleted}
            title="Filter task selesai"
            onClick={() => board && saveView(board.id, { ...view, hideCompleted: !view.hideCompleted })}
          >
            <ListFilter size={16} />
          </button>
          <button className="search-trigger" onClick={() => setSearch(true)} aria-label="Cari kartu" title="Cari kartu">
            <Search size={16} />
          </button>
          <div ref={accountRef} className="account-wrap">
            <button className="icon-button" onClick={() => setAccountMenu((value) => !value)} aria-label="Menu akun" aria-expanded={accountMenu}>
              <MoreHorizontal size={19} />
            </button>
            {accountMenu && (
              <div className="popover account-menu">
                <div className="account-name">{engine.username}</div>
                <button
                  onClick={() => {
                    if (dirty.current) {
                      notify({ text: "Simpan edit yang terbuka sebelum keluar." });
                      return;
                    }
                    void engine.logout();
                  }}
                >
                  Keluar
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="canvas-surface" aria-label="Canvas workspace">
        <ReactFlow<CardNodeType>
          nodes={nodes}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          nodesConnectable={false}
          onlyRenderVisibleElements
          nodesDraggable={connected && !layoutBusy && !search && !boardModal}
          nodeDragThreshold={mobile ? 8 : 1}
          minZoom={0.15}
          maxZoom={2}
          deleteKeyCode={null}
          selectionOnDrag={false}
          panOnDrag
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          autoPanOnNodeDrag={!mobile}
          defaultViewport={{ x: view.x, y: view.y, zoom: view.zoom }}
          onNodeDragStart={(_event, node) => {
            dragging.current = node.id;
          }}
          onNodeDragStop={(_event, node) => {
            dragging.current = null;
            pendingPositions.current.set(node.id, node.position);
            void perform({ kind: "layout", boardId: node.data.card.boardId, id: node.id, x: node.position.x, y: node.position.y, front: true }).then((result) => {
              pendingPositions.current.delete(node.id);
              if (!result) setNodes((previous) => previous.map((item) => (item.id === node.id ? { ...item, position: { x: node.data.card.x, y: node.data.card.y } } : item)));
            });
          }}
          onNodeClick={(_event, node) => {
            if (connected && !operation.current && cards.some((card) => card.z > node.data.card.z))
              void perform({ kind: "layout", boardId: node.data.card.boardId, id: node.id, front: true });
          }}
          onMove={(_event, viewport) => setZoom(viewport.zoom)}
          onMoveEnd={(_event, viewport) => rememberCamera(viewport)}
          onPaneClick={() => {
            if (!dirty.current) setEditing(null);
            setAddMenu(false);
          }}
          aria-label="Area canvas"
        >
          <CanvasGuides />
        </ReactFlow>
        <div className="card-measurements" ref={measurementRoot} aria-hidden="true" inert>
          {layoutBusy &&
            cards.map((card) => (
              <article
                key={card.id}
                data-measure-id={card.id}
                style={{ width: card.width }}
                className={
                  "canvas-card " +
                  (card.type === "note" ? "note-card " + card.color : "task-card") +
                  (mobile ? " mobile-card" : "") +
                  (card.completed && card.type === "task" ? " completed" : "")
                }
              >
                <div className="card-header" />
                <div className="card-body">
                  <div className="card-content">
                    <CardPreview card={card} />
                  </div>
                </div>
              </article>
            ))}
        </div>

        {!cards.length && (
          <div className="canvas-empty">
            <h2>{board ? "Kanvas kosong." : "Buat board pertama."}</h2>
            <p>{board ? "Tambahkan catatan atau tugas untuk mulai." : "Satu tempat untuk catatan dan tugasmu."}</p>
            {board ? (
              <button
                className="text-button"
                disabled={!connected}
                onClick={() => {
                  void add("note");
                }}
              >
                Tambahkan note
              </button>
            ) : (
              <button className="button primary" disabled={!connected} onClick={() => setBoardModal("create")}>
                Buat board
              </button>
            )}
          </div>
        )}
        {!!cards.length && !visible.length && (
          <div className="canvas-empty filtered-empty">
            <h2>Semua task selesai.</h2>
            <button className="text-button" onClick={() => board && saveView(board.id, { ...view, hideCompleted: false })}>
              Tampilkan task selesai
            </button>
          </div>
        )}
        <div className="canvas-bottom">
          <div className="creation-dock" role="toolbar" aria-label="Alat canvas">
            <button
              className="select-tool"
              aria-label="Alat pilih"
              title="Pilih kartu"
              onClick={() => {
                if (dirty.current) {
                  onEdit(null);
                  return;
                }
                setEditing(null);
                setAddMenu(false);
                setNodes((current) => current.map((node) => ({ ...node, selected: false })));
              }}
            >
              <MousePointer2 size={17} />
            </button>
            <button
              className="dock-add"
              aria-label="Tambahkan kartu"
              aria-expanded={addMenu}
              title="Tambahkan kartu"
              disabled={!connected || !board || layoutBusy || !!engine.saving}
              onClick={() => setAddMenu((value) => !value)}
            >
              <SquarePlus size={17} />
            </button>
            <span className="dock-divider" />
            <button
              className="dock-tidy"
              aria-label="Rapikan kartu"
              title={editing ? "Selesaikan edit sebelum merapikan" : "Rapikan kartu"}
              disabled={!connected || !board || !cards.length || !!editing || layoutBusy || !!engine.saving}
              aria-busy={layoutBusy}
              onClick={() => {
                void tidy();
              }}
            >
              {layoutBusy ? <LoaderCircle className="spin" size={16} /> : <Grid2X2 size={16} />}
            </button>
            {addMenu && (
              <div className="popover add-menu">
                <button
                  className="dock-note"
                  onClick={() => {
                    void add("note");
                  }}
                >
                  <span>Note</span>
                  <span className="shortcut-key">N</span>
                </button>
                <button
                  className="dock-task"
                  onClick={() => {
                    void add("task");
                  }}
                >
                  <span>Task</span>
                  <span className="shortcut-key">T</span>
                </button>
              </div>
            )}
          </div>
          <div className="canvas-controls">
            <button
              className="icon-button"
              aria-label="Perkecil canvas"
              onClick={() => {
                void flow.zoomOut({ duration: motion(120) });
              }}
            >
              <Minus size={14} />
            </button>
            <button
              className="zoom-label"
              aria-label="Kembalikan zoom ke 100 persen"
              onClick={() => {
                void flow.zoomTo(1, { duration: motion(120) });
              }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              className="icon-button"
              aria-label="Perbesar canvas"
              onClick={() => {
                void flow.zoomIn({ duration: motion(120) });
              }}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      </main>
      {!connected && (
        <div className="connection-banner" role="status">
          <WifiOff size={13} /> Menunggu koneksi. Draft yang terbuka tetap ada di tab ini.
        </div>
      )}
      <Modal
        open={boardModal === "create" || boardModal === "rename"}
        onOpenChange={(open) => {
          if (!open) setBoardModal(null);
        }}
        title={boardModal === "rename" ? "Ubah nama board" : "Buat board"}
      >
        <BoardForm
          key={boardModal}
          board={boardModal === "rename" ? board : undefined}
          onCancel={() => setBoardModal(null)}
          onSubmit={async (name) => {
            const kind = boardModal === "rename" ? "board.rename" : "board.create";
            const pending: NonNullable<typeof boardRequest.current> =
              boardRequest.current?.name === name && boardRequest.current.kind === kind
                ? boardRequest.current
                : { kind, name, boardId: boardModal === "rename" ? board!.id : crypto.randomUUID(), mutationId: crypto.randomUUID() };
            boardRequest.current = pending;
            await mutate(pending, pending.mutationId);
            boardRequest.current = null;
            setBoardModal(null);
            if (boardModal === "create") await navigate(pending.boardId);
          }}
        />
      </Modal>
      <Modal
        open={boardModal === "delete"}
        onOpenChange={(open) => {
          if (!open) setBoardModal(null);
        }}
        title="Hapus board ini?"
        description={"Board “" + (board?.name ?? "") + "” beserta seluruh kartunya akan dihapus permanen. Tindakan ini tidak dapat dibatalkan."}
      >
        <div className="modal-actions">
          <button className="button secondary" onClick={() => setBoardModal(null)}>
            Batal
          </button>
          <button
            className="button danger-button"
            onClick={() => {
              if (!board) return;
              if (dirty.current) {
                notify({ text: "Selesaikan edit sebelum menghapus board." });
                return;
              }
              setBoardModal(null);
              void perform({ kind: "board.delete", boardId: board.id }, "Board dihapus permanen.");
            }}
          >
            Hapus board
          </button>
        </div>
      </Modal>
      <Modal open={search} onOpenChange={setSearch} title="Cari kartu" className="search-modal">
        <div className="search-input-wrap">
          <Search size={19} />
          <input autoFocus aria-label="Cari judul atau isi kartu" placeholder="Cari judul atau isi kartu…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="search-results">
          {results.length ? (
            results.map((card) => (
              <button
                key={card.id}
                onClick={() => {
                  if (view.hideCompleted && card.completed && board) saveView(board.id, { ...view, hideCompleted: false });
                  setSearch(false);
                  setQuery("");
                  setTimeout(() => {
                    void flow.fitView({ nodes: [{ id: card.id }], maxZoom: 1, padding: 0.6, duration: motion(200) });
                  }, 60);
                }}
              >
                <span className="search-result-kind">{card.type === "note" ? "Note" : "Task"}</span>
                <span>
                  <strong>{card.title || "Tanpa judul"}</strong>
                  <small>
                    {card.type === "note" ? textContent(card.doc).slice(0, 80) || "Note kosong" : card.description.slice(0, 80) || (card.completed ? "Selesai" : "Belum selesai")}
                  </small>
                </span>
                <MoveUpRight size={15} />
              </button>
            ))
          ) : (
            <p className="search-empty">Belum ada kartu yang cocok.</p>
          )}
        </div>
      </Modal>
      <Dialog.Root
        open={mobile && !!displayedEditor && !!editing}
        onOpenChange={(open) => {
          if (!open) onEdit(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content
            className={"mobile-editor-sheet " + (displayedEditor?.type === "note" ? displayedEditor.color : "")}
            style={visualViewport ? { maxHeight: visualViewport.height * 0.9, bottom: visualViewport.bottom } : undefined}
            onEscapeKeyDown={(event) => {
              if (dirty.current || document.querySelector(".mobile-editor-sheet .format-popover")) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (dirty.current) event.preventDefault();
            }}
          >
            <div className="sheet-grip" />
            <Dialog.Title className="sheet-title">{displayedEditor?.type === "note" ? "Edit note" : "Edit task"}</Dialog.Title>
            <Dialog.Description className="sr-only">Perubahan tersimpan otomatis.</Dialog.Description>
            {displayedEditor && (
              <Suspense fallback={<div className="editor-loading">Membuka editor…</div>}>
                <CardEditor
                  key={displayedEditor.id}
                  card={displayedEditor}
                  connected={connected}
                  mutate={mutate}
                  onDirty={onDirty}
                  onClose={() => {
                    dirty.current = false;
                    setEditing(null);
                  }}
                />
              </Suspense>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
export default function CanvasRoot({ engine }: { engine: Engine }) {
  return (
    <ReactFlowProvider>
      <Canvas engine={engine} />
    </ReactFlowProvider>
  );
}
