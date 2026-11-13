import { COLORS, GRID, MAX_NOTES, MAX_NOTE_CHARS } from "../crdt/limits";
import { graphemes, isChar } from "../crdt/ops";
import { Session, type Lost, type ResetReason } from "../sync/session";

const RESET_TEXT: Record<ResetReason, string> = {
  expired: "This board expired and started over empty.",
  notes: `Together with the other copies, this board went over its limit of ${MAX_NOTES} notes while this copy was offline. The server refused this copy's changes, so it was reloaded from the server.`,
  text: "Together with the other copies, a note went over its size limit while this copy was offline. The server refused this copy's changes, so it was reloaded from the server.",
  full: "This board is full. Start a fresh one below.",
  malformed: "The server refused a change, so this copy was reloaded.",
};

interface NoteUi {
  el: HTMLElement;
  input: HTMLTextAreaElement;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

function randomName(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}
export { randomName };

// 128 Bit aus der sicheren Zufallsquelle des Browsers.
function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// FNV-1a: kurzer Fingerabdruck, damit man gleiche Stände mit bloßem Auge erkennt.
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Setzt fremden Text ein und lässt die Schreibmarke dort, wo sie inhaltlich war.
function setText(input: HTMLTextAreaElement, next: string): void {
  const prev = input.value;
  const focused = document.activeElement === input;
  const { selectionStart, selectionEnd } = input;
  input.value = next;
  if (!focused) return;
  let head = 0;
  while (head < prev.length && head < next.length && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < prev.length - head && tail < next.length - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const shift = (pos: number): number =>
    pos <= head ? pos : pos >= prev.length - tail ? pos + next.length - prev.length : next.length - tail;
  input.setSelectionRange(shift(selectionStart), shift(selectionEnd));
}

function copy(text: HTMLTextAreaElement): HTMLButtonElement {
  const button = make("button", "", "Copy my text");
  button.type = "button";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text.value);
      button.textContent = "Copied";
    } catch {
      text.select(); // ohne Erlaubnis für die Zwischenablage: markieren, Strg+C geht dann
    }
  });
  return button;
}

// Ein Brett auf der Seite: eine eigene Kopie mit eigener Verbindung.
export class Pane {
  readonly session: Session;
  readonly editedOffline = new Set<string>();
  hash = "";

  private el = make("section", "pane");
  private toggle = make("button", "switch");
  private toggleText = make("span");
  private state = make("span", "state");
  private notice = make("p", "notice");
  private surface = make("div", "surface");
  private blank = make("p", "blank", "No notes yet. Add one.");
  private notes = new Map<string, NoteUi>();
  private dragging: string | null = null;

  constructor(
    host: HTMLElement,
    name: string,
    boardId: string,
    private onChange: () => void,
    private trackEdits: () => boolean,
  ) {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${location.host}/api/board/${boardId}/ws`;
    this.session = new Session(
      (events) => {
        const ws = new WebSocket(url);
        ws.onopen = () => events.open();
        ws.onmessage = (e) => events.message(String(e.data));
        ws.onclose = (e) => events.close(e.code);
        return { send: (text) => ws.readyState === WebSocket.OPEN && ws.send(text), close: () => ws.close() };
      },
      {
        change: () => this.queue(),
        reset: (reason, lost) => {
          if (lost.changes > 0) this.showLost(RESET_TEXT[reason], lost);
          else this.say(RESET_TEXT[reason]);
          this.editedOffline.clear();
        },
      },
      { replica: () => randomName(10), key: secret, defer: (fn, ms) => void setTimeout(fn, ms) },
    );

    const head = make("header", "pane-head");
    const add = make("button", "add", "Add note");
    add.type = "button";
    add.addEventListener("click", () => this.addNote());
    this.toggle.type = "button";
    this.toggle.setAttribute("role", "switch");
    this.toggle.setAttribute("aria-label", `${name} connection`);
    this.toggle.append(make("i"), this.toggleText);
    this.toggle.addEventListener("click", () => {
      if (this.session.status === "offline") this.session.connect();
      else this.session.disconnect();
    });
    this.state.setAttribute("aria-live", "off");
    this.notice.hidden = true;
    this.notice.setAttribute("role", "status");
    head.append(make("h3", "", name), this.state, add, this.toggle);
    this.surface.append(this.blank);
    this.el.append(head, this.notice, this.surface);
    host.append(this.el);

    setInterval(() => this.session.ping(), 30_000);
    this.session.connect();
    this.render();
  }

  get offline(): boolean {
    return this.session.status === "offline";
  }

  // Beispielnotiz für ein frisches Brett.
  seed(text: string): void {
    const board = this.session.board;
    const add = board.addNote(120, 160, 0);
    const id = board.view()[0]!.id;
    this.session.local([add, ...board.insertText(id, 0, text)]);
  }

  // Bleibt stehen, bis man es schließt: hier steht Text, der sonst weg wäre.
  private showLost(why: string, lost: Lost): void {
    const n = lost.changes === 1 ? "1 unsent change was" : `${lost.changes} unsent changes were`;
    const box = make("div", "lost");
    box.setAttribute("role", "alert");
    box.append(make("p", "", `${why} ${n} discarded.`));
    if (lost.texts.length) {
      const text = make("textarea");
      text.readOnly = true;
      text.rows = Math.min(6, lost.texts.join("\n\n").split("\n").length + 1);
      text.value = lost.texts.join("\n\n");
      text.setAttribute("aria-label", "Your text from the affected notes");
      box.append(make("p", "", "Your text from the affected notes, as it was in this copy:"), text);
    }
    const close = make("button", "", "Dismiss");
    close.type = "button";
    close.addEventListener("click", () => box.remove());
    const row = make("div", "row");
    row.append(...(box.querySelector("textarea") ? [copy(box.querySelector("textarea")!)] : []), close);
    box.append(row);
    this.el.querySelector(".lost")?.remove();
    this.notice.after(box);
  }

  private say(text: string): void {
    this.notice.textContent = text;
    this.notice.hidden = false;
    setTimeout(() => (this.notice.hidden = true), 9000);
  }

  // Sofort zeichnen, nicht erst beim nächsten Bild: sonst könnte ein
  // Tastendruck auf ein veraltetes Textfeld treffen, und der Vergleich
  // „vorher/nachher“ würde gerade empfangenen Text wieder löschen.
  private queue(): void {
    this.render();
    this.onChange();
  }

  private addNote(): void {
    const board = this.session.board;
    if (board.created >= MAX_NOTES) return this.say(`A board holds at most ${MAX_NOTES} notes, deleted ones included.`);
    const n = board.created;
    const op = board.addNote(80 + ((n * 290) % 840), 80 + ((n * 170) % 840), n % COLORS);
    this.session.local([op]);
    this.render();
    this.notes.get(`${op.id.c}.${op.id.r}`)?.input.focus();
  }

  private render(): void {
    const { session } = this;
    const view = session.board.view();
    const live = new Set(view.map((note) => note.id));
    for (const [id, ui] of this.notes) {
      if (live.has(id)) continue;
      ui.el.remove();
      this.notes.delete(id);
    }
    for (const note of view) {
      const ui = this.notes.get(note.id) ?? this.build(note.id);
      if (this.dragging !== note.id) {
        ui.el.style.setProperty("--x", String(note.x / GRID));
        ui.el.style.setProperty("--y", String(note.y / GRID));
      }
      ui.el.dataset.color = String(note.color);
      if (ui.input.value !== note.text) setText(ui.input, note.text);
    }
    this.blank.hidden = view.length > 0;

    this.hash = fingerprint(JSON.stringify(view));
    this.el.dataset.status = session.status;
    this.toggle.setAttribute("aria-checked", String(session.status !== "offline"));
    this.toggleText.textContent =
      session.status === "online" ? "Online" : session.status === "connecting" ? "Connecting" : "Offline";
    const waiting = session.unsynced > 0 && session.status !== "online" ? ` · ${session.unsynced} unsent` : "";
    this.state.replaceChildren("state ", make("code", "", this.hash), waiting);
    if (session.expired) this.say("This board expired. Switch back on to start over empty.");
  }

  private build(id: string): NoteUi {
    const el = make("article", "note");
    const grip = make("div", "grip");
    const paint = make("button", "paint");
    const bin = make("button", "", "×");
    const input = make("textarea");
    paint.type = bin.type = "button";
    paint.setAttribute("aria-label", "Change color");
    bin.setAttribute("aria-label", "Delete note");
    input.setAttribute("aria-label", "Note text");
    input.maxLength = 400;
    input.spellcheck = false;
    grip.append(paint, bin);
    el.append(grip, input);
    this.surface.append(el);

    paint.addEventListener("click", () => {
      const now = this.session.board.view().find((note) => note.id === id);
      if (now) this.session.local([this.session.board.recolor(id, (now.color + 1) % COLORS)]);
    });
    bin.addEventListener("click", () => this.session.local([this.session.board.remove(id)]));
    input.addEventListener("input", () => this.typed(id, input));
    this.drag(id, el, grip);

    const ui = { el, input };
    this.notes.set(id, ui);
    return ui;
  }

  // Das Textfeld meldet nur „vorher“ und „nachher“. Daraus den geänderten
  // Abschnitt bestimmen und als einzelne Zeichen-Änderungen an den CRDT geben.
  private typed(id: string, input: HTMLTextAreaElement): void {
    const board = this.session.board;
    const before = board.chars(id);
    const after = graphemes(input.value);
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;

    const removed = before.length - head - tail;
    const room = MAX_NOTE_CHARS - board.textSize(id);
    const added = after.slice(head, after.length - tail).filter(isChar).slice(0, room);
    const ops = [...board.deleteText(id, head, removed), ...board.insertText(id, head, added.join(""))];
    if (room <= 0 && after.length - tail > head) this.say("This note has reached its size limit.");
    if (input.value !== board.text(id)) setText(input, board.text(id));
    if (ops.length === 0) return;
    if (this.trackEdits()) this.editedOffline.add(id);
    this.session.local(ops);
  }

  private drag(id: string, el: HTMLElement, grip: HTMLElement): void {
    let dx = 0;
    let dy = 0;
    let sentAt = 0;
    let spot: [number, number] | null = null;
    const send = (): void => {
      if (spot) this.session.local([this.session.board.move(id, spot[0], spot[1])]);
      spot = null;
    };
    grip.addEventListener("pointerdown", (e) => {
      if (e.target !== grip) return;
      const box = el.getBoundingClientRect();
      dx = e.clientX - box.left;
      dy = e.clientY - box.top;
      this.dragging = id;
      el.classList.add("held");
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener("pointermove", (e) => {
      if (this.dragging !== id) return;
      const area = this.surface.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const unit = (v: number, span: number): number =>
        span <= 0 ? 0 : Math.round(Math.min(1, Math.max(0, v / span)) * GRID);
      spot = [
        unit(e.clientX - area.left - dx, area.width - box.width),
        unit(e.clientY - area.top - dy, area.height - box.height),
      ];
      el.style.setProperty("--x", String(spot[0] / GRID));
      el.style.setProperty("--y", String(spot[1] / GRID));
      // Unterwegs nur ab und zu senden, damit das andere Brett mitzieht.
      if (e.timeStamp - sentAt > 120) {
        sentAt = e.timeStamp;
        send();
      }
    });
    const drop = (): void => {
      if (this.dragging !== id) return;
      this.dragging = null;
      el.classList.remove("held");
      send();
    };
    grip.addEventListener("pointerup", drop);
    grip.addEventListener("pointercancel", drop);
  }
}
