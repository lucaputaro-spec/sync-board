import { DurableObject } from "cloudflare:workers";
import { MAX_REPLICAS, MAX_SOCKETS, TTL_MS } from "./crdt/limits";
import type { Env } from "./env";
import { BoardLog, type Row } from "./sync/log";
import { CLOSE_EXPIRED } from "./sync/protocol";
import { RoomCore, type Peer, type PeerMeta } from "./sync/server";

// Bremse je Verbindung. Lebt nur im Arbeitsspeicher und beginnt nach einer
// Ruhephase des Objekts neu, das reicht gegen Dauerfeuer.
const WINDOW_MS = 10_000;
const WINDOW_MAX = 150;

// Ein Durable Object je Brett. Hält die WebSockets und das Protokoll in SQLite.
export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null;
  private traffic = new WeakMap<WebSocket, { since: number; n: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // "ping" hält die Leitung offen, ohne das Objekt aus dem Schlaf zu holen.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response("This board is busy", { status: 503 });
    }
    const pair = new WebSocketPair();
    // Mit acceptWebSocket darf das Objekt zwischen Nachrichten schlafen.
    // Schlafende Objekte verbrauchen kein Laufzeit-Kontingent.
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return ws.close(1003, "text only");
    const now = Date.now();
    let use = this.traffic.get(ws);
    if (!use || now - use.since > WINDOW_MS) this.traffic.set(ws, (use = { since: now, n: 0 }));
    if (++use.n > WINDOW_MAX) return ws.close(1008, "too many messages");

    const core = await this.open();
    core.handle(peer(ws), () => this.ctx.getWebSockets().map(peer), message);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // schon zu
    }
  }

  async alarm(): Promise<void> {
    await this.wipe();
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_EXPIRED, "board expired");
  }

  private async open(): Promise<RoomCore> {
    if (this.core && Date.now() < this.core.expiresAt) return this.core;
    if (this.core) await this.wipe(); // Wecker kam zu spät

    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS owners (replica TEXT PRIMARY KEY, key TEXT NOT NULL)");
    let epoch = sql.exec("SELECT v FROM meta WHERE k = 'epoch'").toArray()[0]?.v as number | undefined;
    if (epoch !== undefined && Date.now() >= epoch + TTL_MS) {
      await this.wipe();
      return this.open();
    }
    if (epoch === undefined) {
      epoch = Date.now();
      sql.exec("INSERT INTO meta (k, v) VALUES ('epoch', ?)", epoch);
      await this.ctx.storage.setAlarm(epoch + TTL_MS);
    }
    const log = new BoardLog({
      rows: (after) => sql.exec("SELECT seq, data FROM log WHERE seq > ? ORDER BY seq", after).toArray() as unknown as Row[],
      append: (seq, data) => void sql.exec("INSERT INTO log (seq, data) VALUES (?, ?)", seq, data),
    });
    const keys = {
      get: (replica: string) =>
        (sql.exec("SELECT key FROM owners WHERE replica = ?", replica).toArray()[0]?.key as string | undefined) ?? null,
      add: (replica: string, key: string) =>
        void sql.exec("INSERT INTO owners (replica, key) VALUES (?, ?)", replica, key),
      full: () => (sql.exec("SELECT COUNT(*) AS n FROM owners").one().n as number) >= MAX_REPLICAS,
    };
    this.core = new RoomCore(log, keys, epoch, epoch + TTL_MS);
    return this.core;
  }

  private async wipe(): Promise<void> {
    this.core = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

function peer(ws: WebSocket): Peer {
  return {
    send: (text) => {
      try {
        ws.send(text);
      } catch {
        // Verbindung ist weg, der Browser holt beim Wiederverbinden alles nach
      }
    },
    close: (code, reason) => ws.close(code, reason),
    meta: () => ws.deserializeAttachment() as PeerMeta | null,
    setMeta: (meta) => ws.serializeAttachment(meta),
  };
}
