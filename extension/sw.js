// Service worker: the extension's hub.
//   overlay (every page)  ->  start / stop / mute / volume / typed text  ->  offscreen document (the call)
//   offscreen (the call)  ->  state updates                               ->  overlays
//   offscreen (agent RPC) ->  browser actions                             ->  tabs API here, or the page's content script
// The call lives in an offscreen document, not here: service workers can't use the microphone
// and Chrome stops them when idle. Past calls are kept by sessions.js, what Sarjy knows about you by memory.js.

importScripts("config.js", "sessions.js", "memory.js");

const NAV_TIMEOUT_MS = 20000;
const SETTLE_MS = 400;          // after an action, give the page a moment to react before reporting
const RPC_LIMIT_BYTES = 15000;  // LiveKit RPC payloads are capped at 15 KiB
// Page actions after which the page may change (navigate, open a menu, ...): wait for it before reporting.
const SETTLES = new Set(["left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag",
                         "left_mouse_up", "type", "key", "form_input"]);
// Pages where Chrome doesn't let extensions run scripts.
const LOCKED = /^(chrome|chrome-extension|edge|about|view-source|devtools|chrome-search):|^https:\/\/chromewebstore\.google\.com/;
const CONTENT_SCRIPTS = chrome.runtime.getManifest().content_scripts[0].js;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const inCall = (s) => s.status === "connecting" || s.status === "connected";
class ToolError extends Error {}  // a tool failure the agent should see as is

// ---------------------------------------------------------------- call state, mirrored for overlays
let state = { status: "idle" };
chrome.storage.session.get("state").then((s) => { if (s.state) state = s.state; });

function setState(next) {
  state = next;
  chrome.storage.session.set({ state });
  Sessions.record(state);
  broadcast({ to: "overlay", state });
  chrome.action.setBadgeText({ text: { connecting: "…", connected: "on", error: "!" }[state.status] || "" });
  chrome.action.setBadgeBackgroundColor({ color: state.status === "error" ? "#dc2626" : "#16a34a" });
  chrome.action.setTitle({ title: inCall(state) ? "Sarjy: end the call" : "Sarjy: start talking" });
}

async function broadcast(msg) {
  // Active tabs only; a background tab's overlay asks for the state when it becomes visible.
  for (const tab of await chrome.tabs.query({ active: true })) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
}

// ---------------------------------------------------------------- the offscreen document (the call)
async function offscreenOpen() {
  return (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0;
}

let creating = null;
async function ensureOffscreen() {
  if (await offscreenOpen()) return;
  creating ??= chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Holds the voice call: the microphone goes to the agent and its voice plays back.",
  }).finally(() => { creating = null; });
  await creating;
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({ ...msg, to: "offscreen" });

const COMMANDS = {
  async start(msg) {  // msg.session: continue that past session; otherwise a new one
    const { tokenUrl, accessKey, volume } = await chrome.storage.local.get(["tokenUrl", "accessKey", "volume"]);
    if (inCall(state)) await COMMANDS.stop();
    const session = { id: msg.session || Sessions.newId(), messages: msg.session ? await Sessions.messages(msg.session) : [] };
    await ensureOffscreen();
    return toOffscreen({ cmd: "start", tokenUrl: tokenUrl || SARJY_DEFAULTS.tokenUrl,
                         accessKey: accessKey || SARJY_DEFAULTS.accessKey, session, volume: volume ?? 1 });
  },
  async stop() {
    await toOffscreen({ cmd: "stop" }).catch(() => {});
    if (await offscreenOpen()) await chrome.offscreen.closeDocument();  // releases the microphone
    setState({ ...state, status: "idle", agentState: null, userSpeaking: false });
  },
  mute: (msg) => toOffscreen(msg),
  text: (msg) => toOffscreen(msg),
  volume: (msg) => toOffscreen(msg).catch(() => {}),  // no call: the next one reads it from storage
  openSetup: () => chrome.runtime.openOptionsPage(),
};

async function command(cmd, msg = {}) {
  if (Object.hasOwn(COMMANDS, cmd)) await COMMANDS[cmd](msg);
}

// ---------------------------------------------------------------- tabs
const changes = [];  // tab changes since the last report, in Claude's browser_state form
chrome.tabs.onCreated.addListener((t) => changes.push({ type: "tab_opened", tab_id: `tab-${t.id}` }));
chrome.tabs.onRemoved.addListener((id) => changes.push({ type: "tab_closed", tab_id: `tab-${id}` }));

const agentWindow = () => chrome.windows.getLastFocused({ windowTypes: ["normal"] });

// The tab with this "tab-N" id, or the active one.
async function resolveTab(tabId) {
  if (tabId) {
    const id = Number(String(tabId).replace(/^tab-/, ""));
    try { return await chrome.tabs.get(id); } catch { throw new ToolError(`No tab ${JSON.stringify(tabId)}. Use list_tabs to see the open tabs.`); }
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId: (await agentWindow()).id });
  if (!tab) throw new ToolError("No active tab.");
  return tab;
}

async function browserState() {
  const tabs = (await chrome.tabs.query({ windowId: (await agentWindow()).id })).map((t) => ({
    tab_id: `tab-${t.id}`, title: (t.title || "").slice(0, 4096), url: (t.url || t.pendingUrl || "").slice(0, 4096),
    ...(t.active && { active: true }),
  }));
  return { type: "browser_state", tabs, state_changes: changes.splice(0, 200) };
}

async function waitLoaded(tabId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  await sleep(150);  // let the navigation start
  while (Date.now() < until) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === "complete") return true;
    await sleep(100);
  }
  return false;
}

// The agent may only open public web pages: no browser pages, files, localhost or LAN addresses.
// (By name only: an extension can't resolve DNS, so a public name pointing at a LAN address passes.)
function checkUrl(raw) {
  let url = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  let u;
  try { u = new URL(url); } catch { throw new ToolError(`Not a valid URL: ${raw}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ToolError("Only http and https URLs are allowed.");
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isPrivateHost(h)) throw new ToolError(`Blocked: ${h} is not a public internet address.`);
  return u.href;
}

function isPrivateHost(h) {
  const localName = h === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h) || !h.includes(".") && !h.includes(":");
  const ipv4 = /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);  // the last one is carrier-grade NAT
  const ipv6 = h === "::1" || h.includes(":") && /^(fc|fd|fe8|fe9|fea|feb)/.test(h);
  return localName || ipv4 || ipv6;
}

// Back/forward through the page's own history: Chrome's back button (and tabs.goBack) skips pages
// that moved on without a real user gesture, which is every page the agent clicked through.
async function historyGo(tab, delta) {
  const before = (await chrome.tabs.get(tab.id)).url;
  const ran = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (d) => history.go(d), args: [delta] })
    .then(() => true, () => false);
  if (!ran) await (delta < 0 ? chrome.tabs.goBack(tab.id) : chrome.tabs.goForward(tab.id)).catch(() => {});
  await sleep(300);
  const t = await chrome.tabs.get(tab.id);
  if (t.url === before && t.status === "complete") throw new ToolError(`No page to go ${delta < 0 ? "back" : "forward"} to.`);
}

async function navigate(tab, input) {
  const url = (input.url || "").trim();
  if (url === "back" || url === "forward") await historyGo(tab, url === "back" ? -1 : 1);
  else if (url === "reload") await chrome.tabs.reload(tab.id);
  else await chrome.tabs.update(tab.id, { url: checkUrl(url) });
  const done = await waitLoaded(tab.id, NAV_TIMEOUT_MS);
  const t = await chrome.tabs.get(tab.id);
  return `Navigated to ${t.url || t.pendingUrl} (${t.title || "untitled"})${done ? "" : ", still loading"}.`;
}

async function capture(tab, label) {
  if (!tab.active) throw new ToolError("Screenshots only work on the active tab: switch_tab to it first.");
  await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
  // Voice tools return text only, so the image isn't sent back.
  return `${label} (you can't see images: use read_page or get_page_text to know what's on the page).`;
}

// ---------------------------------------------------------------- tools
// Tools run here with the tabs API; any other member is an in-page action (page_actions.js).
const TAB_TOOLS = {
  async new_tab() {
    await chrome.tabs.create({ windowId: (await agentWindow()).id, active: true, url: "about:blank" });
    return { browser_state: await browserState() };
  },
  list_tabs: async () => ({ browser_state: await browserState() }),
  async switch_tab(input) {
    const tab = await resolveTab(input.tab_id);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { browser_state: await browserState() };
  },
  async close_tab(input) {
    await chrome.tabs.remove((await resolveTab(input.tab_id)).id);
    return { browser_state: await browserState() };
  },
  async wait(input) {
    const secs = clamp(Number(input.duration) || 0, 0, 30);
    await sleep(secs * 1000);
    return { text: `Waited ${secs}s.` };
  },
  navigate: async (input) => ({ text: await navigate(await resolveTab(input.tab_id), input) }),
  screenshot: async (input) => ({ text: await capture(await resolveTab(input.tab_id), "Screenshot taken") }),
  async zoom(input) {
    const tab = await resolveTab(input.tab_id);
    const [x0, y0, x1, y1] = input.region || [];
    if (!(x1 > x0 && y1 > y0)) throw new ToolError("region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0");
    return { text: await capture(tab, `Zoomed into [${x0}, ${y0}, ${x1}, ${y1}]`) };
  },
};

async function sendToPage(tab, member, input) {
  if (LOCKED.test(tab.url || "")) {
    throw new ToolError(`This is a browser page (${tab.url.split("/").slice(0, 3).join("/")}) that extensions can't act on: navigate to a website first.`);
  }
  const msg = { to: "page", member, input };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  } catch {
    // Tabs opened before the extension was installed or reloaded have no content script yet.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS })
      .catch((e) => { throw new ToolError(`Can't act on this page: ${e.message}`); });
    return chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  }
}

async function pageTool(member, input) {
  const tab = await resolveTab(input.tab_id);
  const result = await sendToPage(tab, member, input);
  if (!result) throw new ToolError("The page didn't answer: try again.");
  if (result.open_tab) {  // a ctrl-click or middle-click on a link
    await chrome.tabs.create({ url: checkUrl(result.open_tab), openerTabId: tab.id, active: false });
    delete result.open_tab;
  }
  if (!result.is_error && SETTLES.has(member)) {
    await sleep(SETTLE_MS);
    await waitLoaded(tab.id, 3000);
  }
  return result;
}

// Keeps the reply inside LiveKit's RPC size limit by cutting the text.
function fit(result) {
  const bytes = (r) => new TextEncoder().encode(JSON.stringify(r)).length;
  let over = bytes(result) - RPC_LIMIT_BYTES;
  while (over > 0 && result.text) {
    result.text = result.text.slice(0, Math.max(0, result.text.length - over - 100)) + "\n[Cut to fit: read a smaller part with read_page ref=... or find.]";
    over = bytes(result) - RPC_LIMIT_BYTES;
  }
  return result;
}

// Runs one of the agent's browser actions: {text, is_error, browser_state?}.
async function tool(member, input = {}) {
  let result;
  try {
    result = { ...(Object.hasOwn(TAB_TOOLS, member) ? await TAB_TOOLS[member](input) : await pageTool(member, input)) };
    // Like Claude's tool: report tab changes (a link opened a tab, ...) with any action.
    if (changes.length) result.browser_state = await browserState();
    result.is_error = Boolean(result.is_error);
  } catch (e) {
    result = { text: e instanceof ToolError ? e.message : `${e.name || "Error"}: ${e.message}`, is_error: true };
  }
  return fit(result);
}

// ---------------------------------------------------------------- messages
// Clippy's sprite strips, as base64 for the overlay (clippy.js explains why).
async function clippyAsset(name) {
  if (!/^[A-Za-z0-9_]+\.png$/.test(name)) throw new Error("bad asset name");
  const res = await fetch(chrome.runtime.getURL("clippy/" + name));
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Requests with a reply; any other cmd is a command for the call (COMMANDS).
const HANDLERS = {
  getState: () => state,
  clippyAsset: (msg) => clippyAsset(msg.name).catch(() => null),
  sessions: () => Sessions.list(),
  deleteSession: async (msg) => { await Sessions.remove(msg.id); return { ok: true }; },
  clearSessions: async () => { await Sessions.clear(); return { ok: true }; },
  async memory(msg) {  // from the agent (via offscreen.js) or the overlay's Memory view
    const r = await Memory.handle(msg);
    if (msg.action !== "list" && !r.error) broadcast({ to: "overlay", memoryChanged: true });
    return r;
  },
  tool: (msg) => tool(msg.member, msg.input),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.to !== "sw") return;
  if (msg.event === "state") { setState(msg.state); return; }
  if (msg.event === "mic_denied") { chrome.tabs.create({ url: "setup.html?reason=mic" }); return; }
  const handle = Object.hasOwn(HANDLERS, msg.cmd) ? HANDLERS[msg.cmd]
    : async () => { await command(msg.cmd, msg); return { ok: true }; };
  Promise.resolve(msg).then(handle).then(reply, (e) => reply({ ok: false, error: e.message }));
  return true;  // the reply comes asynchronously
});

// The toolbar button starts a call, or ends the one that's on.
chrome.action.onClicked.addListener(async () => {
  const { state: saved } = await chrome.storage.session.get("state");  // this worker may have just woken up
  await command(inCall(saved || state) ? "stop" : "start").catch(() => {});
});

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === "install") chrome.tabs.create({ url: "setup.html" });
});
