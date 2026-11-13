// Deckel gegen Missbrauch. Server und Browser nutzen dieselben Werte.
export const GRID = 1000; // Position als Promille der Brettfläche
export const COLORS = 5;
export const MAX_NOTES = 24; // je Brett, gelöschte zählen mit
export const MAX_NOTE_CHARS = 1200; // je Notiz, gelöschte Zeichen zählen mit
export const MAX_OPS = 20_000; // je Brett
export const MAX_BATCHES = 6_000; // je Brett, eine Zeile im Speicher pro Paket
export const MAX_MSG_OPS = 200;
export const MAX_MSG_BYTES = 64_000;
export const MAX_SOCKETS = 16; // gleichzeitige Verbindungen je Brett
export const MAX_REPLICAS = 500; // je Brett, jede geladene Seite ist ein neues Gerät
export const TTL_MS = 24 * 60 * 60 * 1000;
