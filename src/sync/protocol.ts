import type { Op } from "../crdt/ops";

// Nachrichten zwischen Browser und Server, als JSON über den WebSocket.
export type ClientMsg =
  | { t: "hello"; replica: string; key: string; epoch: number | null; cursor: number }
  | { t: "ops"; ops: Op[] };

export type RejectReason = "malformed" | "notes" | "text" | "full";

export type ServerMsg =
  | { t: "welcome"; epoch: number; expiresAt: number }
  | { t: "ops"; seq: number; ops: unknown[] }
  | { t: "ready" }
  | { t: "reject"; reason: RejectReason };

export const CLOSE_EXPIRED = 4001;
