import { MAX_BATCHES, MAX_MSG_OPS, MAX_NOTES, MAX_NOTE_CHARS, MAX_OPS } from "../crdt/limits";
import { parseOp, type Op } from "../crdt/ops";
import type { RejectReason } from "./protocol";

export interface Row {
  seq: number;
  data: string; // JSON-Liste der Änderungen eines Pakets
}

export interface LogStore {
  rows(after: number): Row[];
  append(seq: number, data: string): void;
}

export type Submit = { ok: true; row: Row | null } | { ok: false; reason: RejectReason };

// Das Protokoll eines Bretts auf dem Server: nur anhängen, nie ändern.
// Der Server entscheidet keinen Konflikt. Er prüft Form und Deckel, sortiert
// Doppelte aus und gibt den Rest in Eingangsreihenfolge weiter.
export class BoardLog {
  private seq = 0;
  private ops = 0;
  private notes = 0;
  private chars = new Map<string, number>();
  private last = new Map<string, number>(); // höchster Zähler je Gerät
  private top = 0; // höchster Zähler überhaupt

  constructor(private store: LogStore) {
    for (const row of store.rows(0)) {
      this.seq = row.seq;
      this.count(JSON.parse(row.data) as Op[]);
    }
  }

  since(cursor: number): Row[] {
    return cursor >= this.seq ? [] : this.store.rows(cursor);
  }

  submit(replica: string, raw: unknown): Submit {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MSG_OPS) {
      return { ok: false, reason: "malformed" };
    }
    const fresh: Op[] = [];
    const chars = new Map<string, number>();
    let last = this.last.get(replica) ?? 0;
    let notes = this.notes;
    for (const item of raw) {
      const op = parseOp(item);
      if (!op || op.id.r !== replica) return { ok: false, reason: "malformed" };
      // Ein Gerät zählt streng aufwärts. Was nicht neuer ist als das zuletzt
      // Gespeicherte, kam schon einmal an (erneut gesendet nach Abbruch).
      if (op.id.c <= last) continue;
      // Ein ehrliches Gerät liegt höchstens um seine ungesendeten Änderungen
      // über dem Protokoll. Ohne diese Grenze könnte eine einzige Änderung mit
      // riesigem Zähler alle Uhren ans Maximum treiben und das Brett lahmlegen.
      if (op.id.c > this.top + MAX_OPS) return { ok: false, reason: "malformed" };
      last = op.id.c;
      if (op.k === "add" && ++notes > MAX_NOTES) return { ok: false, reason: "notes" };
      if (op.k === "ins") {
        const n = (chars.get(op.note) ?? 0) + 1;
        chars.set(op.note, n);
        if ((this.chars.get(op.note) ?? 0) + n > MAX_NOTE_CHARS) return { ok: false, reason: "text" };
      }
      fresh.push(op);
    }
    if (fresh.length === 0) return { ok: true, row: null };
    if (this.ops + fresh.length > MAX_OPS || this.seq >= MAX_BATCHES) return { ok: false, reason: "full" };

    const row = { seq: this.seq + 1, data: JSON.stringify(fresh) };
    this.store.append(row.seq, row.data);
    this.seq = row.seq;
    this.count(fresh);
    return { ok: true, row };
  }

  private count(ops: Op[]): void {
    this.ops += ops.length;
    for (const op of ops) {
      if (op.id.c > (this.last.get(op.id.r) ?? 0)) this.last.set(op.id.r, op.id.c);
      if (op.id.c > this.top) this.top = op.id.c;
      if (op.k === "add") this.notes++;
      if (op.k === "ins") this.chars.set(op.note, (this.chars.get(op.note) ?? 0) + 1);
    }
  }
}
