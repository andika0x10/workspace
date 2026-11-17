import { describe, expect, it } from "vitest";
import { CARD_GAP, findCardSpace, tidyCards, type CardRect } from "../lib/layout";

function expectSeparate(cards: CardRect[]) {
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i],
        b = cards[j];
      expect(a.x + a.width + CARD_GAP <= b.x || b.x + b.width + CARD_GAP <= a.x || a.y + a.height + CARD_GAP <= b.y || b.y + b.height + CARD_GAP <= a.y).toBe(true);
    }
}
describe("canvas layout", () => {
  it("packs mixed sizes and distant cards without overlaps and preserves reading order", () => {
    const cards = Array.from({ length: 30 }, (_, i) => ({
      id: String(i).padStart(2, "0"),
      x: i % 2 ? -90000 : 80000,
      y: i * 2000 - 40000,
      width: i % 3 ? 280 : 560,
      height: 228 + i * 13,
    }));
    const positions = tidyCards(cards);
    const packed = positions.map((position) => ({ ...cards.find((card) => card.id === position.id)!, ...position }));
    expect(positions.map((position) => position.id)).toEqual(cards.map((card) => card.id));
    expect(positions[0]).toEqual({ id: "00", x: 0, y: 0 });
    expect(new Set(positions.map((position) => position.x)).size).toBe(4);
    expectSeparate(packed);
    expect(tidyCards(packed)).toEqual(positions);
    expect(tidyCards([])).toEqual([]);
    expect(tidyCards([cards[0]])).toEqual([{ id: "00", x: 0, y: 0 }]);
  });
  it("fills nearby space in every direction and accounts for all card sizes", () => {
    const origin = { id: "center", x: -100, y: -120, width: 560, height: 460 };
    const cards = [origin];
    const target = { x: 40, y: -4 };
    for (let i = 0; i < 12; i++) cards.push({ id: String(i), ...findCardSpace(cards, target), width: 280, height: 228 });
    expectSeparate(cards);
    expect(cards.some((card) => card.x < origin.x)).toBe(true);
    expect(cards.some((card) => card.x > origin.x + origin.width)).toBe(true);
    expect(cards.some((card) => card.y < origin.y)).toBe(true);
    expect(cards.some((card) => card.y > origin.y + origin.height)).toBe(true);
    expect(findCardSpace([], { x: -20, y: 30 })).toEqual({ x: -20, y: 30 });
  });
});
