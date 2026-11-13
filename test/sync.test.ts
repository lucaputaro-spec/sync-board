import { describe, expect, it } from "vitest";
import { MAX_NOTES, MAX_OPS, MAX_REPLICAS } from "../src/crdt/limits";
import type { Op } from "../src/crdt/ops";
import { BoardLog, type Row } from "../src/sync/log";
import { RoomCore, type Peer, type PeerMeta } from "../src/sync/server";
import { Session, type Lost, type ResetReason, type TransportEvents } from "../src/sync/session";
import { mismatch, randomEdit } from "./edits";
import { rng, SEED, type Rng } from "./random";

const RUNS = 400;

// Server und Leitungen im Arbeitsspeicher. Jede Leitung hat zwei Warteschlangen.
// Wird sie gekappt, ist alles verloren, was gerade unterwegs war.
class Net {
  rows: Row[] = [];
  owners = new Map<string, string>();
  keys = {
    get: (replica: string) => this.owners.get(replica) ?? null,
    add: (replica: string, key: string) => void this.owners.set(replica, key),
    full: () => this.owners.size >= MAX_REPLICAS,
  };
  core = new RoomCore(
    new BoardLog({
      rows: (after) => this.rows.filter((row) => row.seq > after),
      append: (seq, data) => void this.rows.push({ seq, data }),
    }),
    this.keys,
    1,
    2,
  );
  wires: Wire[] = [];
  timers: (() => void)[] = [];
  private names = 0;

  session(resets: ResetReason[] = [], lost: Lost[] = []): Session {
    return new Session(
      (events) => {
        const wire = new Wire(this, events);
        this.wires.push(wire);
        return { send: (text) => wire.up.push(text), close: () => wire.cut(false) };
      },
      { change: () => {}, reset: (reason, l) => (resets.push(reason), lost.push(l)) },
      {
        replica: () => `device${String(this.names++).padStart(4, "0")}`,
        key: () => `secret${String(this.names++).padStart(14, "0")}`, defer: (fn) => void this.timers.push(fn) },
    );
  }

  // Ein zufälliger kleiner Schritt im Netz. false, wenn nichts mehr zu tun ist.
  step(r: Rng): boolean {
    const busy = this.wires.filter((wire) => !wire.opened || wire.up.length > 0 || wire.down.length > 0);
    const choices = busy.length + this.timers.length;
    if (choices === 0) return false;
    const at = r.int(choices);
    if (at < busy.length) busy[at]!.step(r);
    else this.timers.splice(at - busy.length, 1)[0]!();
    return true;
  }

  settle(r: Rng): void {
    while (this.step(r));
  }
}

class Wire {
  up: string[] = [];
  down: string[] = [];
  opened = false;
  private meta: PeerMeta | null = null;
  readonly peer: Peer = {
    send: (text) => void this.down.push(text),
    close: () => this.cut(true),
    meta: () => this.meta,
    setMeta: (meta) => void (this.meta = meta),
  };

  constructor(
    private net: Net,
    private events: TransportEvents,
  ) {}

  step(r: Rng): void {
    if (!this.opened) {
      this.opened = true;
      return this.events.open();
    }
    const upFirst = this.down.length === 0 || (this.up.length > 0 && r.chance(0.5));
    if (upFirst) {
      this.net.core.handle(this.peer, () => this.net.wires.map((wire) => wire.peer), this.up.shift()!);
    } else {
      this.events.message(this.down.shift()!);
    }
  }

  cut(tellBrowser: boolean): void {
    this.net.wires = this.net.wires.filter((wire) => wire !== this);
    if (tellBrowser) this.events.close();
  }
}

function play(seed: number): void {
  const r = rng(seed);
  const net = new Net();
  const sessions = Array.from({ length: 2 + r.int(3) }, () => net.session());
  const all: Op[] = [];
  sessions.forEach((session) => session.connect());

  for (let step = 60 + r.int(200); step > 0; step--) {
    const session = r.pick(sessions);
    const roll = r.next();
    if (roll < 0.35) {
      // Unter dem Deckel bleiben: Ablehnungen prüft ein eigener Test.
      if (all.filter((op) => op.k === "add").length >= MAX_NOTES) continue;
      const ops = randomEdit(session.board, r);
      all.push(...ops);
      session.local(ops);
    } else if (roll < 0.9) {
      net.step(r);
    } else if (roll < 0.94) {
      session.disconnect(); // Schalter „Verbindung trennen“
    } else if (roll < 0.98) {
      session.connect();
    } else if (net.wires.length > 0) {
      r.pick(net.wires).cut(true); // Leitung reißt von selbst ab
    }
  }

  sessions.forEach((session) => session.connect());
  net.settle(r);

  const late = net.session(); // kommt erst jetzt dazu und bekommt alles vom Server
  late.connect();
  net.settle(r);

  const first = JSON.stringify(late.board.dump());
  for (const session of sessions) {
    expect(session.unsynced).toBe(0);
    expect(JSON.stringify(session.board.dump())).toBe(first);
  }
  expect(mismatch(late.board, all)).toBeNull();
}

describe("syncing through the server", () => {
  it(`survives random disconnects and lost messages (${RUNS} schedules, seed ${SEED})`, () => {
    for (let run = 0; run < RUNS; run++) {
      try {
        play(SEED + run);
      } catch (error) {
        throw new Error(`schedule ${run} (seed ${SEED + run}) failed: ${String(error)}`, { cause: error });
      }
    }
  });

  it("merges two boards that edited the same note while offline", () => {
    const r = rng(SEED);
    const net = new Net();
    const [a, b] = [net.session(), net.session()];
    a.connect();
    b.connect();
    const add = a.board.addNote(0, 0, 0);
    a.local([add]);
    a.local(a.board.insertText(a.board.view()[0]!.id, 0, "plan"));
    net.settle(r);
    const note = b.board.view()[0]!.id;

    a.disconnect();
    b.disconnect();
    a.local(a.board.insertText(note, 4, " A"));
    b.local(b.board.insertText(note, 0, "B "));
    net.settle(r);
    expect(a.board.text(note)).toBe("plan A");
    expect(b.board.text(note)).toBe("B plan");
    expect(a.unsynced).toBe(2);

    a.connect();
    b.connect();
    net.settle(r);
    expect(a.board.text(note)).toBe("B plan A");
    expect(b.board.text(note)).toBe("B plan A");
    expect(a.unsynced + b.unsynced).toBe(0);
  });

  it("resets a copy to the server state when it breaks the note limit offline", () => {
    const r = rng(SEED);
    const net = new Net();
    const resets: ResetReason[] = [];
    const lost: Lost[] = [];
    const [a, b] = [net.session(), net.session(resets, lost)];
    a.connect();
    net.settle(r);
    for (let i = 0; i < MAX_NOTES; i++) a.local([a.board.addNote(i, i, 0)]);
    b.local([b.board.addNote(5, 5, 1)]); // offline, weiß nichts vom vollen Brett
    const mine = b.board.view()[0]!.id;
    b.local(b.board.insertText(mine, 0, "Call Dana about pricing"));
    net.settle(r);
    b.connect();
    net.settle(r);
    expect(resets).toEqual(["notes"]);
    // Die Seite bekommt vor dem Zurücksetzen gesagt, was verworfen wird.
    expect(lost).toEqual([{ changes: 1 + "Call Dana about pricing".length, texts: ["Call Dana about pricing"] }]);
    expect(b.board.view()).toEqual(a.board.view());
    expect(b.board.view().length).toBe(MAX_NOTES);
    b.local([b.board.move(b.board.view()[0]!.id, 7, 7)]); // danach wieder normal benutzbar
    net.settle(r);
    expect(a.board.view()[0]).toMatchObject({ x: 7, y: 7 });
  });

  it("drops the local copy when the board expired and was created again", () => {
    const r = rng(SEED);
    const net = new Net();
    const resets: ResetReason[] = [];
    const a = net.session(resets);
    a.connect();
    a.local([a.board.addNote(1, 1, 0)]);
    net.settle(r);
    a.disconnect();

    const fresh = new Net(); // derselbe Name, aber neu entstanden
    fresh.core = new RoomCore(new BoardLog({ rows: () => [], append: () => {} }), fresh.keys, 99, 100);
    const wires: Wire[] = [];
    const again = new Session(
      (events) => {
        const wire = new Wire(fresh, events);
        fresh.wires.push(wire);
        wires.push(wire);
        return { send: (text) => wire.up.push(text), close: () => wire.cut(false) };
      },
      { change: () => {}, reset: (reason) => resets.push(reason) },
      { replica: () => `later${resets.length}xxxx`, key: () => `secret${resets.length}xxxxxxxxxxxxx`, defer: (fn) => void fresh.timers.push(fn) },
    );
    again.connect();
    fresh.settle(r);
    again.disconnect();
    // Epoche 99 ist gemerkt, jetzt meldet sich ein Server mit anderer Epoche.
    fresh.core = new RoomCore(new BoardLog({ rows: () => [], append: () => {} }), fresh.keys, 123, 124);
    again.local([again.board.addNote(2, 2, 0)]);
    again.connect();
    fresh.settle(r);
    expect(resets).toEqual(["expired"]);
    expect(again.board.view()).toEqual([]);
    expect(again.status).toBe("online");
  });

  it("does not let a device write under another device's name", () => {
    const r = rng(SEED);
    const net = new Net();
    const victim = net.session();
    victim.connect();
    victim.local([victim.board.addNote(1, 1, 0)]);
    net.settle(r);
    const name = victim.board.replica;

    const sent: string[] = [];
    let closed = 0;
    let meta: PeerMeta | null = null;
    const thief: Peer = {
      send: (text) => void sent.push(text),
      close: () => void closed++,
      meta: () => meta,
      setMeta: (m) => void (meta = m),
    };
    const hello = { t: "hello", replica: name, key: "wrongwrongwrongwrong", epoch: null, cursor: 0 };
    net.core.handle(thief, () => [thief], JSON.stringify(hello));
    expect(closed).toBe(1);
    expect(meta).toBeNull();
    const forged = { k: "add", id: { c: 999, r: name }, x: 1, y: 1, color: 0 };
    net.core.handle(thief, () => [thief], JSON.stringify({ t: "ops", ops: [forged] }));
    expect(net.rows.length).toBe(1);

    victim.local([victim.board.move(victim.board.view()[0]!.id, 9, 9)]); // der Besitzer kann weiter schreiben
    net.settle(r);
    expect(net.rows.length).toBe(2);
    expect(victim.unsynced).toBe(0);
  });

  it("only counts devices that have written, so viewers and bare hellos use up no slots", () => {
    const net = new Net();
    const peer = (): Peer & { closed: number } => {
      let meta: PeerMeta | null = null;
      const p = { closed: 0, send: () => {}, close: () => void p.closed++, meta: () => meta, setMeta: (m: PeerMeta) => void (meta = m) };
      return p;
    };
    const hello = (p: Peer, n: number): void =>
      net.core.handle(p, () => [p], JSON.stringify({ t: "hello", replica: `flood${n}xx`, key: "floodfloodfloodflood", epoch: null, cursor: 0 }));
    const write = (p: Peer, n: number): void =>
      net.core.handle(p, () => [p], JSON.stringify({ t: "ops", ops: [{ k: "pos", id: { c: 1, r: `flood${n}xx` }, note: "1.nobody00", x: 1, y: 1 }] }));

    const flood = peer();
    for (let n = 0; n < MAX_REPLICAS * 2; n++) hello(flood, n); // viele Kennungen, nichts geschrieben
    expect(net.owners.size).toBe(0);

    for (let n = 0; n < MAX_REPLICAS; n++) {
      const p = peer();
      hello(p, n);
      write(p, n);
    }
    expect(net.owners.size).toBe(MAX_REPLICAS);

    const late = peer();
    hello(late, MAX_REPLICAS + 1);
    expect(late.closed).toBe(0); // zuschauen geht weiter
    write(late, MAX_REPLICAS + 1);
    expect(late.closed).toBe(1); // schreiben nicht mehr
    expect(net.rows.length).toBe(MAX_REPLICAS);
  });

  it("refuses a change whose counter is far ahead, so one device cannot wear out the clock", () => {
    const log = new BoardLog({ rows: () => [], append: () => {} });
    const add = (c: number) => ({ k: "add", id: { c, r: "device0" }, x: 1, y: 1, color: 0 });
    expect(log.submit("device0", [add(1e12)]).ok).toBe(false);
    expect(log.submit("device0", [add(MAX_OPS + 1)]).ok).toBe(false);
    expect(log.submit("device0", [add(MAX_OPS)]).ok).toBe(true); // lange offline gearbeitet
  });

  it("rejects changes that are malformed or signed with another device's name", () => {
    const log = new BoardLog({ rows: () => [], append: () => {} });
    const good = { k: "add", id: { c: 1, r: "device0" }, x: 1, y: 1, color: 0 };
    expect(log.submit("device1", [good]).ok).toBe(false);
    expect(log.submit("device0", [{ ...good, x: -5 }]).ok).toBe(false);
    expect(log.submit("device0", [{ k: "ins", id: { c: 2, r: "device0" }, note: "1.device0", after: null, ch: "ab" }]).ok).toBe(false);
    expect(log.submit("device0", "nope").ok).toBe(false);
    expect(log.submit("device0", [good])).toMatchObject({ ok: true, row: { seq: 1 } });
    expect(log.submit("device0", [good])).toEqual({ ok: true, row: null }); // doppelt
  });
});
