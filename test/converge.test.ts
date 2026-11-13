import { describe, expect, it } from "vitest";
import { Board } from "../src/crdt/board";
import type { Op } from "../src/crdt/ops";
import { mismatch, randomEdit } from "./edits";
import { rng, SEED } from "./random";

const RUNS = 2000;

// Ein Ablauf: mehrere Kopien ändern gleichzeitig. Jede Änderung liegt für
// jede andere Kopie in einem Postfach und wird irgendwann in zufälliger
// Reihenfolge zugestellt, manche doppelt, manche erst ganz am Schluss.
function play(seed: number): void {
  const r = rng(seed);
  const boards = Array.from({ length: 2 + r.int(4) }, (_, i) => new Board(`replica${i}`));
  const inbox: Op[][] = boards.map(() => []);
  const all: Op[] = [];

  for (let step = 40 + r.int(160); step > 0; step--) {
    const i = r.int(boards.length);
    if (inbox[i]!.length === 0 || r.chance(0.45)) {
      for (const op of randomEdit(boards[i]!, r)) {
        all.push(op);
        boards.forEach((_, j) => {
          if (j === i) return;
          inbox[j]!.push(op);
          if (r.chance(0.15)) inbox[j]!.push(op);
        });
      }
    } else {
      const at = r.int(inbox[i]!.length);
      boards[i]!.apply(inbox[i]![at]!);
      if (!r.chance(0.1)) inbox[i]!.splice(at, 1); // sonst kommt sie später noch einmal
    }
  }

  boards.forEach((board, i) => {
    for (const op of r.shuffle(inbox[i]!)) board.apply(op);
    for (const op of r.shuffle([...all]).slice(0, 20)) board.apply(op);
  });

  const first = JSON.stringify(boards[0]!.dump());
  for (const board of boards) expect(JSON.stringify(board.dump())).toBe(first);
  expect(mismatch(boards[0]!, all)).toBeNull();
}

describe("random schedules", () => {
  it(`all copies end up identical and nothing typed is lost (${RUNS} schedules, seed ${SEED})`, () => {
    for (let run = 0; run < RUNS; run++) {
      try {
        play(SEED + run);
      } catch (error) {
        throw new Error(`schedule ${run} (seed ${SEED + run}) failed: ${String(error)}`, { cause: error });
      }
    }
  });
});
