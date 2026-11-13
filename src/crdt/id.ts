// Jede Änderung bekommt eine eindeutige Kennung: Zähler plus Gerät.
// Der Zähler ist eine Lamport-Uhr: jedes Gerät zählt hoch und springt beim
// Empfang auf den höchsten gesehenen Wert. Dadurch ist eine Änderung, die
// eine andere schon kannte, immer „größer“ als diese.
export interface Id {
  c: number;
  r: string;
}

export const key = (id: Id): string => `${id.c}.${id.r}`;

export function cmp(a: Id, b: Id): number {
  if (a.c !== b.c) return a.c - b.c;
  return a.r < b.r ? -1 : a.r > b.r ? 1 : 0;
}
