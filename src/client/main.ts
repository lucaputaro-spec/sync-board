import { Pane, randomName } from "./pane";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
let boardId = params.get("board") ?? "";
if (!/^[a-z0-9]{10,16}$/.test(boardId)) {
  boardId = randomName(12);
  history.replaceState(null, "", `/?board=${boardId}`);
}
const solo = params.get("view") === "one";

const pair = $("pair");
const verdict = $("verdict");
const steps = [...document.querySelectorAll<HTMLElement>("#steps li")];
const done = [false, false, false, false];
let seeded = false;

const bothOffline = (): boolean => panes.every((pane) => pane.offline);
const panes: Pane[] = [];
panes.push(new Pane(pair, solo ? "This device" : "Board A", boardId, refresh, bothOffline));
if (!solo) panes.push(new Pane(pair, "Board B", boardId, refresh, bothOffline));

function refresh(): void {
  const [a, b] = panes;
  if (!a) return;
  expiry(a.session.expiresAt);
  if (!b) return;

  if (!seeded && a.session.status === "online") {
    seeded = true;
    if (a.session.board.created === 0) a.seed("Take both boards offline, then edit this note on each side.");
  }

  const online = a.session.status === "online" && b.session.status === "online";
  const synced = online && a.session.unsynced === 0 && b.session.unsynced === 0;
  const same = a.hash === b.hash;
  const shared = [...a.editedOffline].some((id) => b.editedOffline.has(id));
  done[0] ||= bothOffline();
  done[1] ||= done[0] && bothOffline() && shared;
  done[2] ||= done[1] && online;
  done[3] ||= done[2] && synced && same;
  const current = done.indexOf(false);
  steps.forEach((li, i) => {
    li.classList.toggle("done", done[i]!);
    li.classList.toggle("busy", i === current);
  });

  verdict.classList.toggle("same", same);
  verdict.classList.toggle("differ", !same);
  const code = (text: string): HTMLElement => Object.assign(document.createElement("code"), { textContent: text });
  if (same) {
    verdict.replaceChildren(
      done[3] ? "Merged. Both boards arrived at the same state: " : "Both boards hold the same state: ",
      code(a.hash),
    );
  } else {
    verdict.replaceChildren(
      "The boards differ right now: ",
      code(a.hash),
      " and ",
      code(b.hash),
      online ? ". Syncing." : ". Switch both back on to merge them.",
    );
  }
}

function expiry(at: number | null): void {
  if (at === null) return;
  const hours = Math.ceil((at - Date.now()) / 3_600_000);
  $("expiry").textContent =
    hours > 1 ? `This board expires in about ${hours} hours.` : "This board expires in less than an hour.";
}

const link = $<HTMLInputElement>("share-link");
const copy = $<HTMLButtonElement>("share-copy");
link.value = `${location.origin}/?board=${boardId}&view=one`;
link.addEventListener("focus", () => link.select());
copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(link.value);
    copy.textContent = "Copied";
  } catch {
    link.select();
    copy.textContent = "Press Ctrl+C";
  }
  setTimeout(() => (copy.textContent = "Copy link"), 2000);
});

// Nichts wird im Browser gespeichert. Wer mit ungesendeten Änderungen geht,
// bekommt deshalb vorher die Rückfrage des Browsers.
addEventListener("beforeunload", (e) => {
  if (panes.some((pane) => pane.session.unsynced > 0)) e.preventDefault();
});

if (solo) {
  document.body.classList.add("solo");
  pair.classList.add("one");
  verdict.hidden = true;
  $("intro").querySelector("h2")!.textContent = "You are on a shared board";
  $("intro").querySelector("p")!.replaceChildren(
    "Everything you change here shows up on every other device with this link. Switch to offline, keep editing, switch back on. ",
    Object.assign(document.createElement("a"), { href: `/?board=${boardId}`, textContent: "See two copies side by side" }),
  );
  $("share-title").textContent = "Invite another device";
}

refresh();
