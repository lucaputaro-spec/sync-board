import { cmp, key, type Id } from "./id";

interface Item {
  id: Id;
  ch: string;
  gone: boolean;
}

// Sequenz-CRDT nach dem RGA-Verfahren (Replicated Growable Array).
// Jedes Zeichen merkt sich, hinter welchem Zeichen es getippt wurde. Gelöschte
// Zeichen bleiben als unsichtbare Platzhalter stehen, damit spätere
// Einfügungen ihren Bezugspunkt noch finden.
export class Text {
  private items: Item[] = [];
  private known = new Set<string>();

  get size(): number {
    return this.items.length;
  }

  has(id: Id): boolean {
    return this.known.has(key(id));
  }

  // Voraussetzung (prüft Board): `after` ist vorhanden und kleiner als `id`.
  insert(id: Id, after: Id | null, ch: string): void {
    let i = after === null ? 0 : this.indexOf(after) + 1;
    // Wollen mehrere Zeichen hinter dasselbe Zeichen, steht das mit der
    // größeren Kennung vorn. Alles, was an einem größeren Geschwister hängt,
    // ist selbst größer (Lamport-Uhr) und wird deshalb mit übersprungen.
    while (i < this.items.length && cmp(this.items[i]!.id, id) > 0) i++;
    this.items.splice(i, 0, { id, ch, gone: false });
    this.known.add(key(id));
  }

  remove(target: Id): void {
    const item = this.items[this.indexOf(target)];
    if (item) item.gone = true;
  }

  toString(): string {
    let out = "";
    for (const item of this.items) if (!item.gone) out += item.ch;
    return out;
  }

  chars(): string[] {
    return this.items.filter((item) => !item.gone).map((item) => item.ch);
  }

  // Kennung des Zeichens, hinter dem an sichtbarer Stelle `index` eingefügt wird.
  anchor(index: number): Id | null {
    if (index <= 0) return null;
    let seen = 0;
    for (const item of this.items) {
      if (!item.gone && ++seen === index) return item.id;
    }
    return this.lastVisible();
  }

  range(index: number, count: number): Id[] {
    const out: Id[] = [];
    let seen = 0;
    for (const item of this.items) {
      if (item.gone) continue;
      if (seen >= index && out.length < count) out.push(item.id);
      seen++;
    }
    return out;
  }

  dump(): [string, string, boolean][] {
    return this.items.map((item) => [key(item.id), item.ch, item.gone]);
  }

  private lastVisible(): Id | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (!this.items[i]!.gone) return this.items[i]!.id;
    }
    return null;
  }

  private indexOf(id: Id): number {
    return this.items.findIndex((item) => item.id.c === id.c && item.id.r === id.r);
  }
}
