import type { CardPosition } from "./model";

export type CardRect = CardPosition & { width: number; height: number };
export const CARD_GAP = 28;

export function tidyCards(cards: CardRect[]): CardPosition[] {
  if (!cards.length) return [];
  const ordered = [...cards].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const columns = Math.min(4, Math.ceil(Math.sqrt(ordered.length)));
  const columnWidth = Math.max(...ordered.map((card) => card.width));
  const positions: CardPosition[] = [];
  let y = 0;
  for (let start = 0; start < ordered.length; start += columns) {
    const row = ordered.slice(start, start + columns);
    row.forEach((card, column) => positions.push({ id: card.id, x: column * (columnWidth + CARD_GAP), y }));
    y += Math.max(...row.map((card) => card.height)) + CARD_GAP;
  }
  return positions;
}

export function findCardSpace(cards: CardRect[], target: { x: number; y: number }, width = 280, height = 228): { x: number; y: number } {
  const candidates = [{ ...target }];
  for (const card of cards) {
    for (const x of [card.x - width - CARD_GAP, card.x + card.width + CARD_GAP]) for (const y of [target.y, card.y, card.y + card.height - height]) candidates.push({ x, y });
    for (const y of [card.y - height - CARD_GAP, card.y + card.height + CARD_GAP]) for (const x of [target.x, card.x, card.x + card.width - width]) candidates.push({ x, y });
  }
  const distance = (point: { x: number; y: number }) => (point.x - target.x) ** 2 + (point.y - target.y) ** 2;
  candidates.sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x);
  const position = candidates.find(
    (point) =>
      Math.abs(point.x) <= 1000000 &&
      Math.abs(point.y) <= 1000000 &&
      cards.every(
        (card) =>
          point.x + width + CARD_GAP <= card.x || point.x >= card.x + card.width + CARD_GAP || point.y + height + CARD_GAP <= card.y || point.y >= card.y + card.height + CARD_GAP
      )
  );
  if (!position) throw new Error("Belum ada ruang kosong di dekat kartu. Rapikan board terlebih dahulu.");
  return position;
}
