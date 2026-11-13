// Fester Startwert: jeder Lauf spielt exakt dieselben Abläufe durch. Schlägt
// ein Test fehl, steht die Nummer des Ablaufs in der Meldung und der Fehler
// lässt sich beliebig oft wiederholen.
export const SEED = 20261112;

export interface Rng {
  next(): number; // 0 <= x < 1
  int(n: number): number; // 0 <= x < n
  chance(p: number): boolean;
  pick<T>(list: readonly T[]): T;
  shuffle<T>(list: T[]): T[];
}

// mulberry32
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (list) => list[int(list.length)]!,
    shuffle: (list) => {
      for (let i = list.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [list[i], list[j]] = [list[j]!, list[i]!];
      }
      return list;
    },
  };
}

const LETTERS = "abcdefghij XYZ\n😀é";

export function word(r: Rng): string {
  const letters = Array.from(LETTERS);
  let out = "";
  for (let n = 1 + r.int(4); n > 0; n--) out += r.pick(letters);
  return out;
}
