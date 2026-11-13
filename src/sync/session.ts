import { Board } from "../crdt/board";
import { key } from "../crdt/id";
import { MAX_MSG_OPS } from "../crdt/limits";
import { parseOp, type Op } from "../crdt/ops";
import { CLOSE_EXPIRED, type ClientMsg, type RejectReason } from "./protocol";

export interface Transport {
  send(text: string): void;
  close(): void;
}

// Der Transport ruft diese Funktionen später auf, nie schon während `dial`.
export interface TransportEvents {
  open(): void;
  message(text: string): void;
  close(code?: number): void;
}

export type Dial = (events: TransportEvents) => Transport;
export type Status = "offline" | "connecting" | "online";
export type ResetReason = RejectReason | "expired";

// Was beim Zurücksetzen verloren geht: wie viele ungesendete Änderungen, und
// der Text der Notizen, die sie betrafen, so wie er in dieser Kopie stand.
// Damit kann die Seite den Text zum Kopieren anbieten, bevor er weg ist.
export interface Lost {
  changes: number;
  texts: string[];
}

export interface Hooks {
  change(): void; // Brett oder Status hat sich geändert
  reset(reason: ResetReason, lost: Lost): void; // lokaler Stand wurde verworfen
}

export interface Runtime {
  replica(): string; // neue zufällige Gerätekennung
  key(): string; // neuer geheimer Schlüssel, 16 bis 32 Zeichen a-z0-9, unabhängig von der Kennung
  defer(fn: () => void, ms: number): void;
}

const FLUSH_MS = 150;

// Eine Kopie des Bretts samt Verbindung. Lokale Änderungen gelten sofort und
// warten in `pending`, bis der Server sie bestätigt hat. Ohne Verbindung
// wächst `pending` einfach weiter.
export class Session {
  board: Board;
  status: Status = "offline";
  expiresAt: number | null = null;
  expired = false;

  private pending: Op[] = [];
  private sent = 0; // so viele aus `pending` sind auf dieser Verbindung schon raus
  private cursor = 0; // letztes Paket, das vom Server ankam
  private epoch: number | null = null;
  private link: Transport | null = null;
  private token: object | null = null;
  private ready = false;
  private wanted = false;
  private flushQueued = false;
  private retries = 0;
  private key: string; // weist diese Kopie beim Server als Besitzer ihrer Kennung aus

  constructor(
    private dial: Dial,
    private hooks: Hooks,
    private rt: Runtime,
  ) {
    this.board = new Board(rt.replica());
    this.key = rt.key();
  }

  get unsynced(): number {
    return this.pending.length;
  }

  local(ops: Op[]): void {
    if (ops.length === 0) return;
    this.pending.push(...ops);
    if (!this.flushQueued) {
      this.flushQueued = true;
      this.rt.defer(() => {
        this.flushQueued = false;
        this.flush();
      }, FLUSH_MS);
    }
    this.hooks.change();
  }

  connect(): void {
    this.wanted = true;
    this.expired = false;
    if (!this.link) this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.token = null;
    this.link?.close();
    this.link = null;
    this.ready = false;
    this.setStatus("offline");
  }

  ping(): void {
    if (this.ready) this.link?.send("ping");
  }

  private open(): void {
    const token = {};
    this.token = token;
    this.setStatus("connecting");
    this.link = this.dial({
      open: () => {
        if (this.token === token) this.hello();
      },
      message: (text) => {
        if (this.token === token) this.receive(text);
      },
      close: (code) => {
        if (this.token !== token) return;
        this.token = null;
        this.link = null;
        this.ready = false;
        if (code === CLOSE_EXPIRED) {
          this.wanted = false;
          this.expired = true;
        }
        if (!this.wanted) return this.setStatus("offline");
        this.setStatus("connecting");
        const wait = Math.min(8000, 500 * 2 ** this.retries++);
        this.rt.defer(() => {
          if (this.wanted && !this.link) this.open();
        }, wait);
      },
    });
  }

  private hello(): void {
    this.send({ t: "hello", replica: this.board.replica, key: this.key, epoch: this.epoch, cursor: this.cursor });
  }

  private send(msg: ClientMsg): void {
    this.link?.send(JSON.stringify(msg));
  }

  private receive(text: string): void {
    if (text === "pong") return;
    let msg: { t?: unknown; [k: string]: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === "welcome" && typeof msg.epoch === "number") {
      // Anderes Startdatum heißt: das Brett ist abgelaufen und neu entstanden.
      const stale = this.epoch !== null && msg.epoch !== this.epoch;
      this.epoch = msg.epoch;
      this.expiresAt = typeof msg.expiresAt === "number" ? msg.expiresAt : null;
      if (stale) {
        // Neue Kopie, neue Gerätekennung: dem Server noch einmal vorstellen.
        this.reset("expired");
        this.hello();
      }
    } else if (msg.t === "ops" && Array.isArray(msg.ops) && typeof msg.seq === "number") {
      const acked = new Set<string>();
      for (const raw of msg.ops) {
        const op = parseOp(raw);
        if (!op) continue;
        this.board.apply(op);
        if (op.id.r === this.board.replica) acked.add(key(op.id));
      }
      this.cursor = msg.seq;
      if (acked.size > 0) this.confirm(acked);
      this.hooks.change();
    } else if (msg.t === "ready") {
      this.ready = true;
      this.retries = 0;
      // Alles Unbestätigte noch einmal. Was der Server schon hat, sortiert er aus.
      this.sent = 0;
      this.setStatus("online");
      this.flush();
    } else if (msg.t === "reject") {
      // Ein Deckel wurde gerissen, meist durch gleichzeitige Arbeit ohne
      // Verbindung. Der Server nimmt von dieser Kopie nichts mehr an, also
      // neu vom Serverstand anfangen.
      this.ready = false;
      this.reset(msg.reason as RejectReason);
      this.hello();
    }
  }

  private confirm(acked: Set<string>): void {
    let before = 0;
    this.pending = this.pending.filter((op, i) => {
      if (!acked.has(key(op.id))) return true;
      if (i < this.sent) before++;
      return false;
    });
    this.sent -= before;
  }

  private flush(): void {
    if (!this.link || !this.ready) return;
    while (this.sent < this.pending.length) {
      const ops = this.pending.slice(this.sent, this.sent + MAX_MSG_OPS);
      this.send({ t: "ops", ops });
      this.sent += ops.length;
    }
  }

  private reset(reason: ResetReason): void {
    const touched = [...new Set(this.pending.map((op) => (op.k === "add" ? key(op.id) : op.note)))];
    const lost: Lost = {
      changes: this.pending.length,
      texts: touched.map((note) => this.board.text(note)).filter((text) => text.trim() !== ""),
    };
    this.board = new Board(this.rt.replica());
    this.key = this.rt.key();
    this.pending = [];
    this.sent = 0;
    this.cursor = 0;
    this.hooks.reset(reason, lost);
  }

  private setStatus(status: Status): void {
    this.status = status;
    this.hooks.change();
  }
}
