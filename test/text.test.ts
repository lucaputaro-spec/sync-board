import { describe, expect, it } from "vitest";
import { Board } from "../src/crdt/board";
import { parseOp, type Op } from "../src/crdt/ops";
import { rng, SEED, word } from "./random";

function pair(): { a: Board; b: Board; note: string } {
  const a = new Board("aaaaaa");
  const b = new Board("bbbbbb");
  const add = a.addNote(0, 0, 0);
  b.apply(add);
  return { a, b, note: a.view()[0]!.id };
}

const give = (to: Board, ops: Op[]): void => ops.forEach((op) => to.apply(op));

describe("text in one note", () => {
  it("behaves like a plain string for one writer (500 random edits)", () => {
    const r = rng(SEED);
    const board = new Board("aaaaaa");
    board.addNote(0, 0, 0);
    const note = board.view()[0]!.id;
    let model: string[] = [];
    for (let i = 0; i < 500; i++) {
      if (model.length === 0 || r.chance(0.65)) {
        const at = r.int(model.length + 1);
        const text = word(r);
        board.insertText(note, at, text);
        model.splice(at, 0, ...Array.from(text));
      } else {
        const at = r.int(model.length);
        const count = 1 + r.int(Math.min(4, model.length - at));
        board.deleteText(note, at, count);
        model = [...model.slice(0, at), ...model.slice(at + count)];
      }
      expect(board.text(note)).toBe(model.join(""));
    }
  });

  it("keeps both words when two people type at the same spot, without mixing letters", () => {
    const { a, b, note } = pair();
    const fromA = a.insertText(note, 0, "hello");
    const fromB = b.insertText(note, 0, "WORLD");
    give(a, fromB);
    give(b, fromA);
    expect(a.text(note)).toBe(b.text(note));
    expect(["helloWORLD", "WORLDhello"]).toContain(a.text(note));
  });

  it("keeps an insertion next to a character someone else deleted meanwhile", () => {
    const { a, b, note } = pair();
    give(b, a.insertText(note, 0, "abc"));
    const del = a.deleteText(note, 1, 1); // "b" weg
    const ins = b.insertText(note, 2, "X"); // hinter "b"
    give(a, ins);
    give(b, del);
    expect(a.text(note)).toBe("aXc");
    expect(b.text(note)).toBe("aXc");
  });

  it("gives the same text when changes arrive backwards and twice", () => {
    const { a, b, note } = pair();
    const ops = [...a.insertText(note, 0, "sync"), ...a.deleteText(note, 1, 2), ...a.insertText(note, 1, "!!")];
    give(b, [...ops].reverse());
    give(b, ops);
    expect(b.text(note)).toBe(a.text(note));
    expect(b.parked).toBe(0);
  });

  it("treats an emoji made of several parts as one character", () => {
    const { a, b, note } = pair();
    const family = "👨‍👩‍👧";
    const typed = a.insertText(note, 0, `x${family}y`);
    expect(typed.length).toBe(3);
    expect(typed.every((op) => parseOp(JSON.parse(JSON.stringify(op))) !== null)).toBe(true);
    give(b, typed);
    const between = b.insertText(note, 1, "!"); // direkt vor dem Emoji
    const gone = a.deleteText(note, 2, 1); // "y"
    give(a, between);
    give(b, gone);
    expect(a.text(note)).toBe(`x!${family}`);
    expect(b.text(note)).toBe(`x!${family}`);
    expect(a.chars(note)).toEqual(["x", "!", family]);
  });

  it("deleting the same character on two devices deletes it once", () => {
    const { a, b, note } = pair();
    give(b, a.insertText(note, 0, "abc"));
    const d1 = a.deleteText(note, 1, 1);
    const d2 = b.deleteText(note, 1, 1);
    give(a, d2);
    give(b, d1);
    expect(a.text(note)).toBe("ac");
    expect(b.text(note)).toBe("ac");
  });
});

describe("position, color, deleting notes", () => {
  it("picks the same winner on both sides when two people move one note", () => {
    const { a, b, note } = pair();
    const m1 = a.move(note, 100, 100);
    const m2 = b.move(note, 900, 900);
    b.apply(m1);
    a.apply(m2);
    expect(a.view()).toEqual(b.view());
    expect(a.view()[0]).toMatchObject({ x: 900, y: 900 }); // gleicher Zähler, "bbbbbb" > "aaaaaa"
  });

  it("a later move beats an earlier one no matter the arrival order", () => {
    const { a, b, note } = pair();
    const first = a.move(note, 1, 1);
    const second = a.move(note, 2, 2);
    b.apply(second);
    b.apply(first);
    expect(b.view()[0]).toMatchObject({ x: 2, y: 2 });
  });

  it("moving and recoloring at the same time keeps both changes", () => {
    const { a, b, note } = pair();
    const move = a.move(note, 500, 500);
    const paint = b.recolor(note, 3);
    b.apply(move);
    a.apply(paint);
    expect(a.view()[0]).toMatchObject({ x: 500, y: 500, color: 3 });
    expect(b.view()).toEqual(a.view());
  });

  it("a deleted note stays deleted even if edits to it arrive later", () => {
    const { a, b, note } = pair();
    const typed = a.insertText(note, 0, "late");
    const rm = b.remove(note);
    a.apply(rm);
    give(b, typed);
    expect(a.view()).toEqual([]);
    expect(b.view()).toEqual([]);
  });

  it("holds back a change until the note it belongs to has arrived", () => {
    const a = new Board("aaaaaa");
    const b = new Board("bbbbbb");
    const add = a.addNote(10, 20, 1);
    const typed = a.insertText(a.view()[0]!.id, 0, "hi");
    give(b, typed);
    expect(b.view()).toEqual([]);
    expect(b.parked).toBe(2);
    b.apply(add);
    expect(b.view()).toEqual(a.view());
    expect(b.parked).toBe(0);
  });
});
