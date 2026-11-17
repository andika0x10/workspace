"use client";
import { useEditor, useEditorState, EditorContent, Extension, posToDOMRect } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Plugin, type Selection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, List } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cardDocument, textContent, safeHref, type Card, type Mutation, type MutationInput, type RoomEvent, type RichNode } from "../../lib/model";
import { ApiError } from "./use-workspace";

type Props = { card: Card; connected: boolean; mutate: (value: MutationInput, mutationId?: string) => Promise<RoomEvent>; onDirty: (dirty: boolean) => void; onClose: () => void };
const taskDescriptionLimit = Extension.create({
  name: "taskDescriptionLimit",
  addProseMirrorPlugins: () => [new Plugin({ filterTransaction: (transaction) => textContent(transaction.doc.toJSON() as RichNode).length <= 4000 })],
});
export default function CardEditor({ card, connected, mutate, onDirty, onClose }: Props) {
  const [draft, setDraft] = useState({ title: card.title, description: card.description, doc: cardDocument(card) });
  const [state, setState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [conflict, setConflict] = useState<Card | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [closing, setClosing] = useState(false);
  const base = useRef(card.contentVersion);
  const saved = useRef(JSON.stringify(draft));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const busy = useRef(false);
  const requestRef = useRef<Extract<Mutation, { kind: "content" }> | null>(null);
  const mounted = useRef(true);
  const [tick, setTick] = useState(0);
  const formatMenu = useRef<HTMLDivElement>(null);
  const dismissedSelection = useRef<Selection | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        orderedList: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        trailingNode: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: "https",
          protocols: ["http", "https", "mailto"],
          isAllowedUri: (url, { defaultProtocol }) => safeHref(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `${defaultProtocol}://${url}`),
        },
      }),
      ...(card.type === "task" ? [taskDescriptionLimit] : []),
    ],
    content: cardDocument(card),
    immediatelyRender: false,
    editorProps: { attributes: { class: "note-prose", "aria-label": card.type === "note" ? "Isi note" : "Deskripsi task", role: "textbox", "aria-multiline": "true" } },
    onSelectionUpdate: () => {
      dismissedSelection.current = null;
    },
    onUpdate: ({ editor: instance }) => {
      const doc = instance.getJSON() as RichNode;
      setDraft((current) => ({ ...current, doc, ...(card.type === "task" ? { description: textContent(doc) } : {}) }));
    },
  });
  const formatting = useEditorState({
    editor,
    selector: ({ editor: instance }) => ({
      bold: instance?.isActive("bold"),
      italic: instance?.isActive("italic"),
      bullet: instance?.isActive("bulletList"),
    }),
  });
  const closeFormatting = () => {
    dismissedSelection.current = editor?.state.selection ?? null;
    editor?.commands.setMeta("note-format", "hide");
  };
  useEffect(() => {
    if (!editor) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (editor.view.dom.contains(target) || formatMenu.current?.contains(target)) return;
      dismissedSelection.current = editor.state.selection;
      editor.commands.setMeta("note-format", "hide");
    };
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [editor]);
  useEffect(() => {
    if (!editor) return;
    let frame: number | undefined;
    const updatePosition = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (!editor.isDestroyed) editor.commands.setMeta("note-format", "updatePosition");
      });
    };
    // Canvas transforms and sheet scrolling move the selection without changing the document.
    const viewport = editor.view.dom.closest(".react-flow__viewport");
    const observer = new MutationObserver(updatePosition);
    if (viewport) observer.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    document.addEventListener("scroll", updatePosition, true);
    document.fonts.addEventListener("loadingdone", updatePosition);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", updatePosition, true);
      document.fonts.removeEventListener("loadingdone", updatePosition);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [editor]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (card.contentVersion <= base.current || busy.current || requestRef.current || JSON.stringify(draftRef.current) !== saved.current) return;
    const value = { title: card.title, description: card.description, doc: cardDocument(card) };
    base.current = card.contentVersion;
    saved.current = JSON.stringify(value);
    setDraft(value);
    editor?.commands.setContent(value.doc, { emitUpdate: false });
  }, [card.contentVersion, card.title, card.description, card.doc, editor]);
  useEffect(() => {
    const dirty = JSON.stringify(draft) !== saved.current || !!requestRef.current;
    onDirty(dirty);
    if (dirty && state === "saved") setState("dirty");
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft, tick, onDirty, state]);
  const save = useCallback(async (): Promise<boolean> => {
    if (busy.current || conflict) return false;
    if (JSON.stringify(draftRef.current) === saved.current && !requestRef.current) return true;
    if (!connected) {
      setState("dirty");
      return false;
    }
    const action = requestRef.current ?? { kind: "content", id: card.id, boardId: card.boardId, baseVersion: base.current, mutationId: crypto.randomUUID(), ...draftRef.current };
    requestRef.current = action;
    busy.current = true;
    setState("saving");
    setError("");
    try {
      const result = await mutate(action, action.mutationId);
      base.current = result.card!.contentVersion;
      saved.current = JSON.stringify({ title: action.title, description: action.description, doc: action.doc });
      requestRef.current = null;
      const clean = JSON.stringify(draftRef.current) === saved.current;
      if (mounted.current) {
        setState(clean ? "saved" : "dirty");
        onDirty(!clean);
      }
      return clean;
    } catch (issue) {
      if (!mounted.current) return false;
      if (issue instanceof ApiError && issue.status === 409 && issue.current) {
        setConflict(issue.current);
        requestRef.current = null;
      }
      if (issue instanceof ApiError && [404, 410].includes(issue.status)) {
        setMissing(true);
        requestRef.current = null;
      }
      setState("error");
      setError(issue instanceof Error ? issue.message : "Note belum tersimpan.");
      return false;
    } finally {
      busy.current = false;
      if (mounted.current) setTick((value) => value + 1);
    }
  }, [card.id, card.boardId, connected, conflict, mutate, onDirty]);
  useEffect(() => {
    if (conflict || !connected || state === "error") return;
    if (JSON.stringify(draft) === saved.current && !requestRef.current) return;
    const timer = setTimeout(() => {
      void save();
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, connected, conflict, save, tick, state]);
  useEffect(() => {
    if (connected && state === "error" && !conflict) {
      setState("dirty");
    }
  }, [connected, conflict]); // retry once connectivity returns
  const close = () => setClosing(true);
  useEffect(() => {
    if (!closing || busy.current) return;
    if (JSON.stringify(draft) === saved.current && !requestRef.current) {
      setClosing(false);
      onClose();
      return;
    }
    if (!connected || conflict || state === "error") {
      setClosing(false);
      return;
    }
    void save();
  }, [closing, draft, state, tick, connected, conflict, save, onClose]);
  const loadServer = () => {
    if (!conflict) return;
    const value = { title: conflict.title, description: conflict.description, doc: cardDocument(conflict) };
    setDraft(value);
    editor?.commands.setContent(value.doc, { emitUpdate: false });
    base.current = conflict.contentVersion;
    saved.current = JSON.stringify(value);
    setConflict(null);
    setState("saved");
    setError("");
    onDirty(false);
  };
  return (
    <div className="card-editor nodrag nopan nowheel">
      <input
        className="title-input"
        aria-label={card.type === "note" ? "Judul note" : "Judul task"}
        placeholder={card.type === "note" ? "Judul note" : "Apa yang perlu dikerjakan?"}
        maxLength={200}
        autoFocus
        value={draft.title}
        onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))}
      />
      {editor && (
        <BubbleMenu
          editor={editor}
          ref={formatMenu}
          pluginKey="note-format"
          updateDelay={0}
          appendTo={() => editor.view.dom.closest<HTMLElement>(".mobile-editor-sheet") ?? document.body}
          shouldShow={({ editor: instance, element, from, to }) =>
            !dismissedSelection.current?.eq(instance.state.selection) &&
            instance.isEditable &&
            !instance.state.selection.empty &&
            !!instance.state.doc.textBetween(from, to).trim() &&
            (instance.isFocused || element.contains(document.activeElement))
          }
          getReferencedVirtualElement={() => {
            const { selection, doc } = editor.state;
            let from = selection.to;
            let to = selection.from;
            // Select-all can include empty paragraphs; anchor to the highlighted text itself.
            doc.nodesBetween(selection.from, selection.to, (node, position) => {
              if (!node.isText) return;
              from = Math.min(from, Math.max(position, selection.from));
              to = Math.max(to, Math.min(position + node.nodeSize, selection.to));
            });
            return from < to ? { getBoundingClientRect: () => posToDOMRect(editor.view, from, to) } : null;
          }}
          options={{
            strategy: "fixed",
            placement: "bottom-start",
            offset: 4,
            flip: false,
            shift: { padding: 8, crossAxis: false },
            onShow: () => {
              // BubbleMenu initializes as absolute; match the strategy before its first measurement in the mobile sheet.
              if (formatMenu.current) formatMenu.current.style.position = "fixed";
            },
          }}
          className="format-popover nodrag nopan nowheel"
          onKeyDown={(event) => {
            if (event.nativeEvent.key === "Escape") {
              event.stopPropagation();
              event.preventDefault();
              editor.commands.focus();
              closeFormatting();
            }
          }}
        >
          <div
            className="format-toolbar"
            role="toolbar"
            aria-label="Format tulisan"
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest("button")) event.preventDefault();
            }}
          >
            <button type="button" aria-label="Bold" title="Bold" aria-pressed={formatting?.bold ?? false} onClick={() => editor.chain().focus().toggleBold().run()}>
              <Bold size={13} />
            </button>
            <button type="button" aria-label="Italic" title="Italic" aria-pressed={formatting?.italic ?? false} onClick={() => editor.chain().focus().toggleItalic().run()}>
              <Italic size={13} />
            </button>
            <button
              type="button"
              aria-label="Bullet"
              title="Bullet list"
              aria-pressed={formatting?.bullet ?? false}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            >
              <List size={14} />
            </button>
          </div>
        </BubbleMenu>
      )}
      <EditorContent
        editor={editor}
        className="note-editable"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            event.preventDefault();
            closeFormatting();
          }
        }}
      />
      {conflict && (
        <div className="conflict-box" role="alert">
          <strong>Ada versi dari perangkat lain</strong>
          <p>Versi tersimpan: {conflict.title || "Tanpa judul"}</p>
          <div className="conflict-preview">
            {conflict.type === "task" ? conflict.description : JSON.stringify(conflict.doc.content?.map((n) => n.content?.map((t) => t.text).join("")).join("\n"))}
          </div>
          <button className="button secondary" onClick={loadServer}>
            Gunakan versi tersimpan
          </button>
          <button
            className="button primary"
            onClick={() => {
              base.current = conflict.contentVersion;
              setConflict(null);
              setState("dirty");
              setError("");
            }}
          >
            Simpan versi perangkat ini
          </button>
        </div>
      )}
      {error && !conflict && (
        <div className="editor-error" role="alert">
          {error}
          {missing ? (
            <>
              <p>Kartu ini sudah dihapus permanen.</p>
              <button
                onClick={() => {
                  onDirty(false);
                  onClose();
                }}
              >
                Tutup editor
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                setState("dirty");
                void save();
              }}
            >
              Coba simpan lagi
            </button>
          )}
        </div>
      )}
      <div className="editor-footer">
        <button className="text-button" onClick={close}>
          Selesai
        </button>
      </div>
    </div>
  );
}
