import type { Board } from "../src/crdt/board";
import { key } from "../src/crdt/id";
import { COLORS, GRID } from "../src/crdt/limits";
import type { Op } from "../src/crdt/ops";
import { word, type Rng } from "./random";

// Eine zufällige Änderung, wie ein Mensch am Brett sie machen würde.
// Prüft nebenbei: ein lokal getippter Text steht sofort genau dort, wo er
// getippt wurde.
export function randomEdit(board: Board, r: Rng): Op[] {
  const notes = board.view();
  if (notes.length === 0 || r.chance(0.06)) {
    return [board.addNote(r.int(GRID + 1), r.int(GRID + 1), r.int(COLORS))];
  }
  const note = r.pick(notes);
  const chars = Array.from(note.text);
  const roll = r.next();
  if (roll < 0.5) {
    const at = r.int(chars.length + 1);
    const text = word(r);
    const ops = board.insertText(note.id, at, text);
    const want = [...chars.slice(0, at), ...Array.from(text), ...chars.slice(at)].join("");
    if (board.text(note.id) !== want) throw new Error(`local insert landed in the wrong place`);
    return ops;
  }
  if (roll < 0.75 && chars.length > 0) {
    const at = r.int(chars.length);
    const count = 1 + r.int(Math.min(3, chars.length - at));
    const ops = board.deleteText(note.id, at, count);
    const want = [...chars.slice(0, at), ...chars.slice(at + count)].join("");
    if (board.text(note.id) !== want) throw new Error(`local delete removed the wrong characters`);
    return ops;
  }
  if (roll < 0.87) return [board.move(note.id, r.int(GRID + 1), r.int(GRID + 1))];
  if (roll < 0.97) return [board.recolor(note.id, r.int(COLORS))];
  return [board.remove(note.id)];
}

// Was laut allen je erzeugten Änderungen am Ende herauskommen muss, ohne den
// CRDT zu benutzen: nichts Getipptes fehlt, nichts Gelöschtes ist noch da,
// bei Position und Farbe gilt die Änderung mit der größten Kennung.
export function expected(all: Op[]): Map<string, { chars: Set<string>; x: number; y: number; color: number }> {
  const newer = (a: Op, b: Op): boolean => a.id.c > b.id.c || (a.id.c === b.id.c && a.id.r > b.id.r);
  const removed = new Set(all.filter((op) => op.k === "rm").map((op) => (op as { note: string }).note));
  const out = new Map<string, { chars: Set<string>; x: number; y: number; color: number; p: Op; c: Op }>();
  for (const op of all) {
    if (op.k === "add" && !removed.has(key(op.id))) {
      out.set(key(op.id), { chars: new Set(), x: op.x, y: op.y, color: op.color, p: op, c: op });
    }
  }
  for (const op of all) {
    if (op.k === "add") continue;
    const note = out.get(op.note);
    if (!note) continue;
    if (op.k === "ins") note.chars.add(key(op.id));
    if (op.k === "pos" && newer(op, note.p)) Object.assign(note, { x: op.x, y: op.y, p: op });
    if (op.k === "color" && newer(op, note.c)) Object.assign(note, { color: op.color, c: op });
  }
  for (const op of all) {
    if (op.k === "del") out.get(op.note)?.chars.delete(key(op.target));
  }
  return out;
}

// Vergleicht eine Kopie mit dem erwarteten Ergebnis. Liefert null oder den Befund.
export function mismatch(board: Board, all: Op[]): string | null {
  const want = expected(all);
  const got = board.dump() as {
    notes: { id: string; pos: [[number, number], string]; color: [number, string]; text: [string, string, boolean][] }[];
  };
  if (got.notes.length !== want.size) return `expected ${want.size} notes, found ${got.notes.length}`;
  for (const note of got.notes) {
    const w = want.get(note.id);
    if (!w) return `note ${note.id} should not exist`;
    const visible = note.text.filter(([, , gone]) => !gone).map(([id]) => id);
    if (visible.length !== w.chars.size || visible.some((id) => !w.chars.has(id))) {
      return `note ${note.id}: a typed character is missing or a deleted one is back`;
    }
    if (note.pos[0][0] !== w.x || note.pos[0][1] !== w.y) return `note ${note.id}: wrong position won`;
    if (note.color[0] !== w.color) return `note ${note.id}: wrong color won`;
  }
  return board.parked === 0 ? null : `${board.parked} changes are still waiting`;
}
