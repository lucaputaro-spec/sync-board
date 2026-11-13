import { MAX_MSG_BYTES } from "../crdt/limits";
import { isReplica } from "../crdt/ops";
import type { BoardLog } from "./log";
import type { ServerMsg } from "./protocol";

export interface PeerMeta {
  replica: string;
  key: string;
  claimed: boolean; // Kennung ist für diese Verbindung schon als eigene bestätigt
  // false nach einer Ablehnung: bis zum nächsten "hello" wird nichts mehr
  // angenommen, weil spätere Änderungen auf der abgelehnten aufbauen könnten.
  ok: boolean;
}

export interface Peer {
  send(text: string): void;
  close(code: number, reason: string): void;
  meta(): PeerMeta | null;
  setMeta(meta: PeerMeta): void;
}

// Wem welche Gerätekennung gehört. Die Kennung steht in jeder Änderung und
// ist damit für alle sichtbar, der Schlüssel dazu nicht.
export interface KeyStore {
  get(replica: string): string | null;
  add(replica: string, key: string): void;
  full(): boolean; // das Brett hat schon zu viele schreibende Geräte
}

const KEY = /^[a-z0-9]{16,32}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const out = (msg: ServerMsg): string => JSON.stringify(msg);

// Die Logik des Raums ohne Cloudflare-Teile, damit sie sich testen lässt.
export class RoomCore {
  constructor(
    private log: BoardLog,
    private keys: KeyStore,
    readonly epoch: number,
    readonly expiresAt: number,
  ) {}

  handle(peer: Peer, everyone: () => Peer[], data: string): void {
    if (data.length > MAX_MSG_BYTES) return peer.close(1009, "message too big");
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return peer.close(1003, "not json");
    }
    if (!isRecord(msg)) return peer.close(1003, "not a message");

    if (msg.t === "hello") {
      if (!isReplica(msg.replica) || typeof msg.key !== "string" || !KEY.test(msg.key)) {
        return peer.close(1008, "bad replica id");
      }
      const owner = this.keys.get(msg.replica);
      if (owner !== null && owner !== msg.key) return peer.close(1008, "replica id belongs to another device");
      peer.setMeta({ replica: msg.replica, key: msg.key, claimed: owner !== null, ok: true });
      const known = msg.epoch === this.epoch && Number.isInteger(msg.cursor) && (msg.cursor as number) >= 0;
      peer.send(out({ t: "welcome", epoch: this.epoch, expiresAt: this.expiresAt }));
      for (const row of this.log.since(known ? (msg.cursor as number) : 0)) {
        peer.send(`{"t":"ops","seq":${row.seq},"ops":${row.data}}`);
      }
      peer.send(out({ t: "ready" }));
      return;
    }

    if (msg.t === "ops") {
      const meta = peer.meta();
      if (!meta) return peer.close(1008, "hello first");
      if (!meta.ok) return;
      // Wer unter einer Kennung zuerst etwas speichert, legt ihren Schlüssel
      // fest. Erst beim Schreiben, nicht schon beim Verbinden: so belegen
      // Zuschauer keinen Platz, und Plätze zu verbrauchen kostet Änderungen.
      if (!meta.claimed) {
        const owner = this.keys.get(meta.replica);
        if (owner !== null && owner !== meta.key) return peer.close(1008, "replica id belongs to another device");
        if (owner === null && this.keys.full()) return peer.close(1013, "too many devices on this board");
      }
      const result = this.log.submit(meta.replica, msg.ops);
      if (!result.ok) {
        peer.setMeta({ ...meta, ok: false });
        peer.send(out({ t: "reject", reason: result.reason }));
        return;
      }
      if (!result.row) return;
      if (!meta.claimed) {
        if (this.keys.get(meta.replica) === null) this.keys.add(meta.replica, meta.key);
        peer.setMeta({ ...meta, claimed: true });
      }
      // Auch an den Absender: das ist seine Bestätigung.
      const text = `{"t":"ops","seq":${result.row.seq},"ops":${result.row.data}}`;
      for (const other of everyone()) if (other.meta()) other.send(text);
      return;
    }

    peer.close(1003, "unknown message");
  }
}
