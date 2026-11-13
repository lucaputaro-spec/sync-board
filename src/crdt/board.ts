import { cmp, key, type Id } from "./id";
import { graphemes, type Op } from "./ops";
import { Text } from "./text";

// Last-Writer-Wins: der Wert mit der größten Kennung gilt, auf jedem Gerät.
interface Reg<T> {
  v: T;
  t: Id;
}

interface Note {
  born: Id;
  pos: Reg<[number, number]>;
  color: Reg<number>;
  text: Text;
}

export interface NoteView {
  id: string;
  x: number;
  y: number;
  color: number;
  text: string;
}

// Eine Kopie des Bretts. `apply` darf jede Änderung in beliebiger Reihenfolge
// und beliebig oft bekommen, das Ergebnis ist auf allen Kopien gleich.
export class Board {
  private clock = 0;
  private notes = new Map<string, Note>();
  private removed = new Set<string>();
  private seen = new Set<string>();
  // Änderungen, deren Bezugspunkt (Notiz oder Zeichen) noch nicht da ist.
  private waiting = new Map<string, Op[]>();

  constructor(readonly replica: string) {}

  apply(op: Op): boolean {
    const k = key(op.id);
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    if (op.id.c > this.clock) this.clock = op.id.c;

    const todo = [op];
    for (let next = todo.pop(); next; next = todo.pop()) {
      const need = this.missing(next);
      if (need) {
        const queue = this.waiting.get(need);
        if (queue) queue.push(next);
        else this.waiting.set(need, [next]);
        continue;
      }
      const provided = this.run(next);
      if (!provided) continue;
      const freed = this.waiting.get(provided);
      if (freed) {
        this.waiting.delete(provided);
        todo.push(...freed);
      }
    }
    return true;
  }

  private missing(op: Op): string | null {
    if (op.k === "add" || this.removed.has(op.note)) return null;
    const note = this.notes.get(op.note);
    if (!note) return `n:${op.note}`;
    if (op.k === "ins" && op.after && !note.text.has(op.after)) return `c:${op.note}:${key(op.after)}`;
    if (op.k === "del" && !note.text.has(op.target)) return `c:${op.note}:${key(op.target)}`;
    return null;
  }

  // Führt aus und meldet, worauf andere Änderungen jetzt nicht mehr warten müssen.
  private run(op: Op): string | null {
    if (op.k === "add") {
      const id = key(op.id);
      this.notes.set(id, {
        born: op.id,
        pos: { v: [op.x, op.y], t: op.id },
        color: { v: op.color, t: op.id },
        text: new Text(),
      });
      return `n:${id}`;
    }
    const note = this.notes.get(op.note);
    if (!note) return null; // Notiz ist gelöscht, Löschen gewinnt
    switch (op.k) {
      case "pos":
        if (cmp(op.id, note.pos.t) > 0) note.pos = { v: [op.x, op.y], t: op.id };
        return null;
      case "color":
        if (cmp(op.id, note.color.t) > 0) note.color = { v: op.color, t: op.id };
        return null;
      case "rm":
        this.notes.delete(op.note);
        this.removed.add(op.note);
        for (const k of [...this.waiting.keys()]) {
          if (k.startsWith(`c:${op.note}:`)) this.waiting.delete(k);
        }
        return null;
      case "ins":
        // Ein Zeichen muss jünger sein als sein Bezugspunkt. Sonst stimmt die
        // Sortierregel in Text.insert nicht, also verwerfen (überall gleich).
        if (op.after && cmp(op.id, op.after) <= 0) return null;
        note.text.insert(op.id, op.after, op.ch);
        return `c:${op.note}:${key(op.id)}`;
      case "del":
        note.text.remove(op.target);
        return null;
    }
  }

  // Lokale Änderungen: erzeugen, sofort selbst anwenden, zum Versenden zurückgeben.

  private stamp(): Id {
    return { c: ++this.clock, r: this.replica };
  }

  private local(op: Op): Op {
    this.apply(op);
    return op;
  }

  addNote(x: number, y: number, color: number): Op {
    return this.local({ k: "add", id: this.stamp(), x, y, color });
  }

  move(note: string, x: number, y: number): Op {
    return this.local({ k: "pos", id: this.stamp(), note, x, y });
  }

  recolor(note: string, color: number): Op {
    return this.local({ k: "color", id: this.stamp(), note, color });
  }

  remove(note: string): Op {
    return this.local({ k: "rm", id: this.stamp(), note });
  }

  insertText(note: string, index: number, text: string): Op[] {
    const target = this.notes.get(note);
    if (!target) return [];
    let after = target.text.anchor(index);
    const ops: Op[] = [];
    for (const ch of graphemes(text)) {
      const id = this.stamp();
      ops.push(this.local({ k: "ins", id, note, after, ch }));
      after = id;
    }
    return ops;
  }

  deleteText(note: string, index: number, count: number): Op[] {
    const target = this.notes.get(note);
    if (!target) return [];
    return target.text
      .range(index, count)
      .map((id) => this.local({ k: "del", id: this.stamp(), note, target: id }));
  }

  // Lesen

  text(note: string): string {
    return this.notes.get(note)?.text.toString() ?? "";
  }

  // Die sichtbaren Zeichen einzeln, so wie sie gespeichert sind.
  chars(note: string): string[] {
    return this.notes.get(note)?.text.chars() ?? [];
  }

  // Belegte Plätze einer Notiz, gelöschte Zeichen eingerechnet.
  textSize(note: string): number {
    return this.notes.get(note)?.text.size ?? 0;
  }

  // Je angelegte Notizen, gelöschte eingerechnet.
  get created(): number {
    return this.notes.size + this.removed.size;
  }

  get parked(): number {
    let n = 0;
    for (const queue of this.waiting.values()) n += queue.length;
    return n;
  }

  view(): NoteView[] {
    return [...this.notes.entries()]
      .sort(([, a], [, b]) => cmp(a.born, b.born))
      .map(([id, n]) => ({ id, x: n.pos.v[0], y: n.pos.v[1], color: n.color.v, text: n.text.toString() }));
  }

  // Vollständiger innerer Zustand in fester Reihenfolge, für die Tests.
  dump(): unknown {
    return {
      removed: [...this.removed].sort(),
      notes: [...this.notes.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, n]) => ({
          id,
          pos: [n.pos.v, key(n.pos.t)],
          color: [n.color.v, key(n.color.t)],
          text: n.text.dump(),
        })),
    };
  }
}
