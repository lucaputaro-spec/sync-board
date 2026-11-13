import type { Id } from "./id";
import { COLORS, GRID } from "./limits";

export type Op =
  | { k: "add"; id: Id; x: number; y: number; color: number }
  | { k: "pos"; id: Id; note: string; x: number; y: number }
  | { k: "color"; id: Id; note: string; color: number }
  | { k: "rm"; id: Id; note: string }
  | { k: "ins"; id: Id; note: string; after: Id | null; ch: string }
  | { k: "del"; id: Id; note: string; target: Id };

const REPLICA = /^[a-z0-9]{6,16}$/;
const NOTE = /^\d{1,13}\.[a-z0-9]{6,16}$/;

export const isReplica = (v: unknown): v is string => typeof v === "string" && REPLICA.test(v);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const int = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function id(v: unknown): Id | null {
  if (!isRecord(v) || !int(v.c, 1, 1e12) || !isReplica(v.r)) return null;
  return { c: v.c, r: v.r };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Zerlegt Text in sichtbare Zeichen. Ein Emoji aus mehreren Teilen (Familie,
// Flagge, Hautton) bleibt so ein einziges Element und kann nicht zerfallen.
export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (part) => part.segment);

// Genau ein sichtbares Zeichen, keine Steuerzeichen außer Zeilenumbruch.
export function isChar(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 32) return false;
  if (v === "\n") return true;
  for (const part of v) {
    const cp = part.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) return false;
  }
  return graphemes(v).length === 1;
}

// Vertrauensgrenze: alles, was aus dem Netz kommt, wird hier geprüft und neu
// aufgebaut. Unbekannte Felder fallen weg.
export function parseOp(raw: unknown): Op | null {
  if (!isRecord(raw)) return null;
  const me = id(raw.id);
  if (!me) return null;
  if (raw.k === "add") {
    if (!int(raw.x, 0, GRID) || !int(raw.y, 0, GRID) || !int(raw.color, 0, COLORS - 1)) return null;
    return { k: "add", id: me, x: raw.x, y: raw.y, color: raw.color };
  }
  const note = raw.note;
  if (typeof note !== "string" || !NOTE.test(note)) return null;
  switch (raw.k) {
    case "pos":
      if (!int(raw.x, 0, GRID) || !int(raw.y, 0, GRID)) return null;
      return { k: "pos", id: me, note, x: raw.x, y: raw.y };
    case "color":
      if (!int(raw.color, 0, COLORS - 1)) return null;
      return { k: "color", id: me, note, color: raw.color };
    case "rm":
      return { k: "rm", id: me, note };
    case "ins": {
      const after = raw.after === null ? null : id(raw.after);
      if ((raw.after !== null && !after) || !isChar(raw.ch)) return null;
      return { k: "ins", id: me, note, after, ch: raw.ch };
    }
    case "del": {
      const target = id(raw.target);
      return target ? { k: "del", id: me, note, target } : null;
    }
    default:
      return null;
  }
}
