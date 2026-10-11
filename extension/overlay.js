// Content script: the overlay on every page while a call is on. Clippy (or a round button without his
// sprites), his reply balloon, his right-click menu and the conversation panel; overlay_ui.js holds their
// look. It only draws the call's state and sends commands; the call itself runs in the offscreen
// document, so it keeps going when you navigate or switch tabs. The toolbar button starts and ends calls.
//
// It sits in a CLOSED shadow root: page styles can't break it, page scripts and session-recording
// tools can't read the conversation, and the agent's read_page/find never see it.
(() => {
if (globalThis.lkOverlayLoaded) return;
globalThis.lkOverlayLoaded = true;

const HOST_ID = "lk-voice-overlay-host";  // page_actions.js looks through this element
const BUBBLE_MS = 5000;                   // the balloon fades this long after the reply's last word
const DRAG_THRESHOLD_PX = 5;              // a press that moves less than this is a click
const SIZES = { small: 0.75, normal: 1, large: 1.4 };  // Clippy's scale, from his right-click menu
const STEPS = [  // [id, label] for the debug view; filled by offscreen.js and the voice container
  ["token", "Token"], ["connect", "Room connection"], ["mic", "Microphone"], ["agent_joined", "Agent joined"],
  ["agent_mic", "Agent gets audio"], ["vad", "VAD (Silero)"], ["stt", "STT (Deepgram)"], ["eou", "End of turn"],
  ["llm", "LLM (Gemma)"], ["tool", "Browser action"], ["tts", "TTS (Cartesia)"], ["playback", "You hear the agent"],
];

const { ICON, HTML } = globalThis.LkOverlayUI;

// ---------------------------------------------------------------- DOM
const host = document.createElement("div");
host.id = HOST_ID;
const root = host.attachShadow({ mode: "closed" });
root.innerHTML = HTML;

const $ = (sel) => root.querySelector(sel);
const wrap = $(".wrap"), orb = $(".orb"), canvas = $(".clippy"), menu = $(".menu"), bubble = $(".bubble");
const panel = $(".panel"), log = $(".log"), input = $("input"), debugBox = $(".debug");

function el(tag, className, text = "") {
  return Object.assign(document.createElement(tag), { className, textContent: text });
}

function mount() {
  if (!host.isConnected) document.documentElement.appendChild(host);
}

const send = (msg) => chrome.runtime.sendMessage({ to: "sw", ...msg }).catch(() => {});
const inCall = (s) => s.status === "connecting" || s.status === "connected";

// ---------------------------------------------------------------- state
let state = { status: "idle", messages: [], steps: {} };  // the call's, from offscreen.js via the service worker
let lastStatus = "idle";
let clippy = null;       // LkClippy once his sprites have loaded; until then, the round button
let open = false;        // the conversation panel
let view = "chat";       // what the panel shows: "chat", "history" (sessions.js) or "memory" (memory.js)
let showDebug = false;
let volume = 1;          // the agent's voice; volume and size are set in the right-click menu
let size = "normal";

function setOpen(value) {
  open = value;
  chrome.storage.local.set({ overlayOpen: open });
  render();
}

// ---------------------------------------------------------------- rendering
function render() {
  const s = state, live = s.status === "connected";
  if (s.status !== lastStatus) {
    if (s.status === "connecting") view = "chat";
    if (s.status === "error") open = true;  // so the problem is visible
    lastStatus = s.status;
  }
  const visible = s.status !== "idle";
  host.style.display = visible ? "" : "none";
  if (!visible) menu.hidden = true;
  visible ? clippy?.wake() : clippy?.pause();
  clippy?.play(live && s.agentState === "speaking" ? "talking" : "normal");

  renderButton(s, live);
  renderMenu(s, live);
  renderBubble(s);
  renderPanel(s, live);
}

// Clippy, or the round button that stands in for him.
function renderButton(s, live) {
  orb.className = "orb " + [
    live && "connected", s.status === "connecting" && "connecting", s.status === "error" && "error", s.muted && "muted",
    s.agentState === "listening" && "listening", s.userSpeaking && "speaking", s.agentState === "thinking" && "thinking",
    s.agentState === "speaking" && "agent-speaking",
  ].filter(Boolean).join(" ");
  orb.innerHTML = s.muted ? ICON.micOff : ICON.mic;
  orb.title = canvas.title = live ? (open ? "Hide the conversation" : "Show the conversation") : "Talk to the agent";
  canvas.style.setProperty("--s", SIZES[size]);
}

function statusLabel(s) {  // [text, dot colour]
  if (s.status === "connecting") return ["Connecting…", "busy"];
  if (s.status === "error") return ["Problem", "bad"];
  if (s.status !== "connected") return ["Not connected", ""];
  if (s.muted) return ["Muted", "busy"];
  if (s.agentState === "thinking") return ["Thinking…", "busy"];
  if (s.agentState === "speaking") return ["Speaking", "on"];
  if (!s.agentState || s.agentState === "initializing") return ["Waiting for the agent…", "busy"];
  return [s.userSpeaking ? "Hearing you…" : "Listening", "on"];
}

function renderPanel(s, live) {
  panel.hidden = !open || s.status === "idle";
  const [text, dot] = statusLabel(s);
  $(".label").textContent = text;
  $(".status .dot").className = "dot " + dot;
  $(".activity").textContent = s.activity || "";

  const mute = $(".mute");
  mute.hidden = !live;
  mute.innerHTML = s.muted ? ICON.micOff : ICON.mic;
  mute.title = s.muted ? "Unmute microphone" : "Mute microphone";
  mute.classList.toggle("on", Boolean(s.muted));
  $(".hang").hidden = !inCall(s);
  input.disabled = $("form button").disabled = !live;

  const err = $(".error");
  err.hidden = !s.error;
  err.textContent = s.error || "";

  $(".hist").classList.toggle("on", view === "history");
  $(".mem").classList.toggle("on", view === "memory");
  $(".dbg").classList.toggle("on", showDebug);
  if (view === "chat") renderChat(s, live);
  debugBox.hidden = !showDebug;
  if (showDebug) renderDebug(s);
}

// Messages: rebuilt each time (at most 60), keeping the view pinned to the bottom when it was.
function renderChat(s, live) {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const msgs = s.messages || [];
  log.replaceChildren();
  if (!msgs.length) log.append(emptyChat(s, live));
  msgs.forEach((m, i) => {
    log.append(el("div", `msg ${m.who}${m.final ? "" : " interim"}${m.old ? " old" : ""}`, m.text));
    if (m.old && !msgs[i + 1]?.old) log.append(el("div", "divider", "— continued now —"));
  });
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function emptyChat(s, live) {
  if (live) return el("div", "empty", "Say something, or type below. Ask it to open a site, read this page, or fill a form.");
  const box = el("div", "empty", "Talk to an agent that can browse for you in this window.");
  const start = el("button", "start", s.status === "connecting" ? "Connecting…" : "Start talking");
  start.disabled = s.status === "connecting";
  start.onclick = () => send({ cmd: "start" });
  box.append(document.createElement("br"), start);
  return box;
}

function renderDebug(s) {
  debugBox.replaceChildren(...STEPS.map(([id, name]) => {
    const step = s.steps?.[id];
    const dot = !step ? "" : step.ok === true ? "on" : step.ok === false ? "bad" : "busy";
    const detail = el("span", "detail", step?.detail || "waiting");
    detail.title = step?.detail || "";
    const row = el("div", "step");
    row.append(el("span", "dot " + dot), el("span", "", name), detail, el("span", "t", step?.t || ""));
    return row;
  }));
}

// ---------------------------------------------------------------- history and memory views
// Drawn only when they change, not on every call update: a rebuild between mouse down and up
// would swallow the click.
function drawList({ heading, empty, items, row, clearLabel, clearQuestion, clear }) {
  log.replaceChildren(el("div", "hhead", heading));
  if (!items.length) log.append(el("div", "empty", empty));
  for (const item of items) log.append(row(item));
  if (items.length) {
    const button = el("button", "clear", clearLabel);
    button.onclick = async () => { if (confirm(clearQuestion)) await clear(); };
    log.append(button);
  }
}

function deleteButton(title, onclick) {
  const button = el("button", "del", "✕");
  Object.assign(button, { title, onclick });
  return button;
}

async function showHistory() {
  view = "history";
  const sessions = await send({ cmd: "sessions" }) || [];
  render();
  drawList({
    heading: "Earlier conversations",
    empty: "Nothing saved yet. Conversations are kept in this browser once you've said something.",
    items: sessions,
    row(x) {
      const row = el("div", "sess"), info = el("div", "info");
      info.append(el("div", "stitle", x.title), el("div", "smeta", `${when(x.updated)} · ${x.count} messages`));
      row.append(info);
      if (x.id === state.session) row.append(el("span", "tag", "this call"));
      else {
        const go = el("button", "go", "Continue");
        go.title = "Continue this conversation (ends the current call)";
        go.onclick = () => { view = "chat"; send({ cmd: "start", session: x.id }); render(); };
        row.append(go);
      }
      row.append(deleteButton("Delete this conversation", async () => { await send({ cmd: "deleteSession", id: x.id }); showHistory(); }));
      return row;
    },
    clearLabel: "Delete all",
    clearQuestion: "Delete all saved conversations?",
    clear: async () => { await send({ cmd: "clearSessions" }); showHistory(); },
  });
}

// Also redrawn when the agent remembers or forgets something.
async function showMemory() {
  view = "memory";
  const { facts = [] } = await send({ cmd: "memory", action: "list" }) || {};
  render();
  drawList({
    heading: "What Sarjy remembers about you",
    empty: 'Nothing yet. Tell Sarjy things like "remember that I prefer Arabic sites" or "call me Abdullah".',
    items: facts,
    row(f) {
      const row = el("div", "sess"), info = el("div", "info");
      info.append(el("div", "fact", f.text));
      row.append(info, deleteButton("Forget this", async () => { await send({ cmd: "memory", action: "remove", id: f.id }); showMemory(); }));
      return row;
    },
    clearLabel: "Forget everything",
    clearQuestion: "Delete everything Sarjy remembers about you?",
    clear: async () => { await send({ cmd: "memory", action: "clear" }); showMemory(); },
  });
}

function when(t) {
  const d = new Date(t), today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
               : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------- right-click menu
function renderMenu(s, live) {
  $(".volume").value = Math.round(volume * 100);
  $(".vol").textContent = Math.round(volume * 100) + "%";
  for (const b of root.querySelectorAll(".sizes button")) b.classList.toggle("on", b.dataset.size === size);
  $(".m-panel").textContent = open ? "Hide the conversation" : "Show the conversation";
  $(".m-mute").hidden = !live;
  $(".m-mute").textContent = s.muted ? "Unmute microphone" : "Mute microphone";
  $(".m-call").textContent = inCall(s) ? "End the call" : "Start talking";
  $(".m-call").classList.toggle("danger", inCall(s));
}

function openMenu(e) {
  e.preventDefault();
  menu.hidden = false;
  menu.style.top = (e.currentTarget.offsetTop + e.currentTarget.offsetHeight + 4) + "px";
  render();
}

canvas.oncontextmenu = orb.oncontextmenu = openMenu;
// Closes on any click outside it, or on Escape. Outside the closed shadow root, events only show the host.
addEventListener("pointerdown", (e) => { if (e.target !== host) menu.hidden = true; }, true);
root.addEventListener("pointerdown", (e) => { if (!e.composedPath().includes(menu)) menu.hidden = true; });
addEventListener("keydown", (e) => { if (e.key === "Escape") menu.hidden = true; }, true);

$(".volume").oninput = (e) => {
  volume = e.target.value / 100;
  chrome.storage.local.set({ volume });
  send({ cmd: "volume", volume });
  render();
};
for (const b of root.querySelectorAll(".sizes button")) {
  b.onclick = () => {
    size = b.dataset.size;
    chrome.storage.local.set({ clippySize: size });
    render();
  };
}
const fromMenu = (fn) => () => { menu.hidden = true; fn(); render(); };
$(".m-panel").onclick = fromMenu(() => setOpen(!open));
$(".m-mute").onclick = fromMenu(() => send({ cmd: "mute", muted: !state.muted }));
$(".m-call").onclick = fromMenu(() => send({ cmd: inCall(state) ? "stop" : "start" }));
$(".m-setup").onclick = fromMenu(() => send({ cmd: "openSetup" }));

// ---------------------------------------------------------------- reply balloon
// Shows the agent's latest reply while it streams in, and fades BUBBLE_MS after the last word.
// It stays away while the conversation panel is open.
let shownReply = null;  // "id:text" of the reply last shown, so an unchanged state doesn't restart the timer
let bubbleTimer = null;
const latestReply = (s) => [...(s.messages || [])].reverse().find((m) => m.who === "agent" && !m.old);
const replyKey = (m) => (m ? m.id + ":" + m.text : null);

function hideBubble() {
  clearTimeout(bubbleTimer);
  bubble.classList.remove("show");
}

function renderBubble(s) {
  if (open || s.status === "idle") return hideBubble();
  const reply = latestReply(s);
  if (replyKey(reply) === shownReply) return;
  shownReply = replyKey(reply);
  if (!reply) return;
  const text = $(".btext");
  text.textContent = reply.text;
  text.scrollTop = text.scrollHeight;
  const below = clippy ? canvas : orb;
  bubble.style.top = (below.offsetTop + below.offsetHeight + 12) + "px";
  bubble.classList.add("show");
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, BUBBLE_MS);
}

bubble.onclick = hideBubble;

// ---------------------------------------------------------------- dragging
// Drag Clippy (or the round button) to move the whole overlay; the position is kept for every page.
let drag = null;       // {dx, dy, x0, y0} while the button is down
let dragged = false;   // the press moved: its click is the end of a drag

function place(x, y) {
  wrap.style.left = Math.max(0, Math.min(x, innerWidth - 60)) + "px";
  wrap.style.top = Math.max(0, Math.min(y, innerHeight - 60)) + "px";
}

for (const handle of [canvas, orb]) {
  handle.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const r = wrap.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY };
    dragged = false;
    handle.setPointerCapture(e.pointerId);
  };
  handle.onpointermove = (e) => {
    if (!drag) return;
    if (!dragged && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_THRESHOLD_PX) return;
    dragged = true;
    wrap.classList.add("dragging");
    place(e.clientX - drag.dx, e.clientY - drag.dy);
  };
  handle.onpointerup = () => {
    if (dragged) chrome.storage.local.set({ clippyPos: { x: parseFloat(wrap.style.left), y: parseFloat(wrap.style.top) } });
    drag = null;
    wrap.classList.remove("dragging");
  };
}

// ---------------------------------------------------------------- panel controls
orb.onclick = canvas.onclick = () => {
  if (dragged) { dragged = false; return; }
  if (state.status === "idle" || state.status === "error") {
    send({ cmd: "start" });
    setOpen(true);
  } else {
    setOpen(!open);
  }
};

const toggleView = (name, show) => () => {
  if (view !== name) return show();
  view = "chat";
  render();
};

$(".min").onclick = () => setOpen(false);
$(".hang").onclick = () => send({ cmd: "stop" });
$(".mute").onclick = () => send({ cmd: "mute", muted: !state.muted });
$(".dbg").onclick = () => { showDebug = !showDebug; render(); };
$(".hist").onclick = toggleView("history", showHistory);
$(".mem").onclick = toggleView("memory", showMemory);
$("form").onsubmit = (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  send({ cmd: "text", text });
};
// Keep typing in the overlay from triggering the page's keyboard shortcuts.
for (const t of ["keydown", "keyup", "keypress"]) input.addEventListener(t, (e) => e.stopPropagation());

// ---------------------------------------------------------------- updates and startup
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.to !== "overlay") return;
  if (msg.state) { state = msg.state; render(); }
  if (msg.memoryChanged && view === "memory") showMemory();
});

// Background tabs miss updates, so a refresh adopts the state without reacting to what changed
// meanwhile: no balloon for replies given while you were in another tab.
async function refresh() {
  const s = await send({ cmd: "getState" });
  if (!s) return;
  state = s;
  lastStatus = s.status;
  shownReply = replyKey(latestReply(s));
  render();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { refresh(); clippy?.wake(); }
});

chrome.storage.local.get(["overlayOpen", "volume", "clippySize", "clippyPos"]).then((saved) => {
  open = saved.overlayOpen ?? false;
  volume = saved.volume ?? 1;
  size = SIZES[saved.clippySize] ? saved.clippySize : "normal";
  if (saved.clippyPos) place(saved.clippyPos.x, saved.clippyPos.y);
  mount();
  render();
  refresh();
  const c = new LkClippy(canvas, send);
  c.load().then((ok) => {
    if (!ok) return;
    clippy = c;
    orb.hidden = true;
    canvas.hidden = false;
    render();
  });
});

// Some sites rebuild the whole document; put the overlay back if it was removed.
new MutationObserver(mount).observe(document.documentElement, { childList: true });
})();
