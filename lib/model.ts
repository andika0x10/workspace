import { z } from "zod";

export const colors = ["mint", "lilac", "yellow"] as const;
export type NoteColor = (typeof colors)[number];
export type RichNode = {
  type: string;
  text?: string;
  content?: RichNode[];
  marks?: { type: string; attrs?: { href: string; target?: string; rel?: string; class?: null } }[];
};
export const emptyDoc: RichNode = { type: "doc", content: [{ type: "paragraph" }] };
export function safeHref(value: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
function validDoc(value: unknown): value is RichNode {
  let count = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (!node || typeof node !== "object" || depth > 12 || ++count > 4000) return false;
    const n = node as RichNode;
    if (!["doc", "paragraph", "text", "bulletList", "listItem", "hardBreak"].includes(n.type)) return false;
    if (n.type === "text" && typeof n.text !== "string") return false;
    if (n.marks && (!Array.isArray(n.marks) || !n.marks.every((m) => ["bold", "italic", "link"].includes(m.type) && (m.type !== "link" || (!!m.attrs && safeHref(m.attrs.href))))))
      return false;
    return !n.content || (Array.isArray(n.content) && n.content.every((c) => walk(c, depth + 1)));
  };
  return walk(value, 0) && (value as RichNode).type === "doc" && JSON.stringify(value).length <= 65536;
}
export const docSchema = z.custom<RichNode>(validDoc, "Format note tidak didukung.");
export type Board = { id: string; name: string; createdAt: number };
export type Card = {
  id: string;
  boardId: string;
  type: "note" | "task";
  title: string;
  description: string;
  doc: RichNode;
  color: NoteColor;
  x: number;
  y: number;
  width: number;
  z: number;
  completed: boolean;
  contentVersion: number;
  updatedAt: number;
};
export const viewSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().min(0.15).max(2),
  hideCompleted: z.boolean(),
});
export type View = z.infer<typeof viewSchema>;
export const initialView: View = { x: 0, y: 0, zoom: 1, hideCompleted: false };
const id = z.uuid();
const coordinate = z.number().finite().min(-1000000).max(1000000);
const positionSchema = z.object({ id, x: coordinate, y: coordinate });
export type CardPosition = z.infer<typeof positionSchema>;
const common = { mutationId: id, boardId: id };
export const mutationSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("board.create"), name: z.string().trim().min(1).max(80) }),
  z.object({ ...common, kind: z.literal("board.rename"), name: z.string().trim().min(1).max(80) }),
  z.object({ ...common, kind: z.literal("board.delete") }),
  z.object({ ...common, kind: z.literal("create"), id, cardType: z.enum(["note", "task"]), x: coordinate, y: coordinate }),
  z.object({
    ...common,
    kind: z.literal("layout.batch"),
    baseSeq: z.number().int().nonnegative(),
    positions: z
      .array(positionSchema)
      .min(1)
      .refine((positions) => new Set(positions.map((position) => position.id)).size === positions.length),
  }),
  z.object({
    ...common,
    kind: z.literal("content"),
    id,
    baseVersion: z.number().int().nonnegative(),
    title: z.string().max(200),
    description: z.string().max(4000),
    doc: docSchema,
  }),
  z.object({
    ...common,
    kind: z.literal("layout"),
    id,
    x: coordinate.optional(),
    y: coordinate.optional(),
    width: z.number().min(240).max(560).optional(),
    front: z.boolean().optional(),
  }),
  z.object({ ...common, kind: z.literal("complete"), id, completed: z.boolean() }),
  z.object({ ...common, kind: z.literal("color"), id, color: z.enum(colors) }),
  z.object({ ...common, kind: z.literal("delete"), id }),
]);
export type Mutation = z.infer<typeof mutationSchema>;
export type MutationInput = Mutation extends infer M ? (M extends Mutation ? Omit<M, "mutationId"> : never) : never;
export type RoomEvent = {
  type: "change";
  seq: number;
  mutationId: string;
  board?: Board;
  card?: Card;
  layout?: { boardId: string; positions: CardPosition[]; updatedAt: number };
  deletedBoardId?: string;
  deletedCard?: { id: string; boardId: string };
};
export type Snapshot = { type: "snapshot"; seq: number; boards: Board[]; cards: Card[]; boardId: string | null; view: View };
export type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string; current?: Card; retryAfter?: number };
export function textContent(node?: RichNode): string {
  if (!node) return "";
  return node.text ?? node.content?.map(textContent).join(node.type === "doc" || node.type === "bulletList" ? "\n" : "") ?? "";
}
export function cardDocument(card: Pick<Card, "type" | "doc" | "description">): RichNode {
  if (card.type === "note" || textContent(card.doc) === card.description) return card.doc;
  return {
    type: "doc",
    content: card.description.split(/\r\n?|\n/).map((line) => ({ type: "paragraph", ...(line ? { content: [{ type: "text", text: line }] } : {}) })),
  };
}
