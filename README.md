# Sync Board

A shared note board that keeps working offline. Every open copy edits on its
own, and all copies converge to the same state once they can talk again, in
whatever order the changes arrive. Unsent changes live only in the open tab:
closing an offline tab drops them.

Live: https://sync-board.lucaputaro.workers.dev/

The page shows two boards side by side. Take both offline, edit the same note
on each, reconnect, and watch them arrive at the same result.

## The interesting part

The merge logic is a CRDT written from scratch, with no CRDT library.

- **Text** uses RGA, a sequence CRDT. Every character has a permanent ID
  (Lamport counter plus replica) and remembers the character it was typed
  after. Deleted characters stay as invisible tombstones. See
  `src/crdt/text.ts`.
- **Position and color** are last-writer-wins registers. The change with the
  highest ID wins on every replica.
- **Deleting a note** wins over concurrent edits to it.
- A change whose reference has not arrived yet waits until it has. Duplicates
  are ignored. So delivery order does not matter.

The server (one Cloudflare Durable Object per board) keeps an append-only log
and relays it over WebSockets. It validates and caps, but never resolves a
conflict.

## Proof

```bash
npm install
npm run test:run
```

The suite plays 2,000 random schedules against the CRDT (2 to 5 replicas,
changes delivered out of order, duplicated, delayed) and 400 more through the
sync layer with random disconnects and lost messages. After each one, all
replicas must be identical, and an independent check confirms that every
typed character is present unless someone deleted it. The seed is fixed, so a
failing schedule can be replayed by number.

## Limits

- Boards expire 24 hours after creation.
- 24 notes per board, 1,200 characters per note (deleted ones count).
- Nothing is persisted in the browser. Closing a tab while offline drops
  unsent changes (the browser asks first).
- If two offline copies together go over the note or text limit, the server
  refuses the later copy. It reports how many changes it discarded, shows the
  affected text for copying, and reloads from the server.
- Runs on Cloudflare's free plan with hard daily quotas. When a quota is hit
  the server returns errors until the next day.

## Stack

Cloudflare Workers, Durable Objects (SQLite storage, WebSocket hibernation),
TypeScript, Vitest. The page is plain HTML and CSS plus one bundled script.

## Run it

```bash
npm run dev
```
