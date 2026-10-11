(() => {
const { Room, RoomEvent, Track, ParticipantKind, RpcError } = LivekitClient;

const RPC_METHOD = "browser";  // the voice agent calls this (voice/browser_tools.py)
const MEMORY_METHOD = "memory";    // ... and this to read, add and remove memories (voice/memory_tools.py)
const HISTORY_METHOD = "history";  // ... and this when it joins, for a continued session (voice/agent.py)
const HISTORY_LIMIT_BYTES = 14000;  // LiveKit RPC payloads are capped at 15 KiB: the most recent part fits
const MAX_MESSAGES = 60;
const PUBLISH_EVERY_MS = 80;   // coalesce state updates (transcripts stream in word by word)
const KEEPALIVE_MS = 20000;    // wakes the service worker so it keeps its tab-change log
const ENDED = { status: "idle", agentState: null, userSpeaking: false, activity: null };

let room = null;
let state = { status: "idle", messages: [], steps: {} };
let t0 = 0;
let keepalive = null;
let history = [];  // the continued session's earlier messages (sessions.js), for the agent
let volume = 1;    // the agent's voice, 0 to 1 (Clippy's right-click menu)

const toSw = (msg) => chrome.runtime.sendMessage({ to: "sw", ...msg });

let pending = null;
function publish() {
  pending ??= setTimeout(() => {
    pending = null;
    toSw({ event: "state", state }).catch(() => {});
  }, PUBLISH_EVERY_MS);
}
function patch(p) { Object.assign(state, p); publish(); }

// Debug steps, shown in the overlay's debug view. ok: true = worked, false = failed, null = in progress.
function step(id, ok, detail = "") {
  const secs = t0 ? ((performance.now() - t0) / 1000).toFixed(1) + "s" : "";
  state.steps = { ...state.steps, [id]: { ok, detail: String(detail).slice(0, 300), t: secs } };
  publish();
}

// Adds a message, or updates it while it streams in.
function say(id, who, text, final = true) {
  const msg = { id, who, text, final };
  const i = state.messages.findIndex((m) => m.id === id);
  state.messages = i >= 0 ? state.messages.with(i, msg) : [...state.messages, msg].slice(-MAX_MESSAGES);
  publish();
}

// What the overlay shows while the agent uses the browser. Its emoji is part of the label.
function activityLabel(member, input) {
  const host = (u) => { try { return new URL(u.includes("://") ? u : "https://" + u).hostname; } catch { return u; } };
  if (member === "navigate") return ["back", "forward", "reload"].includes(input.url) ? `🌐 ${input.url}` : `🌐 opening ${host(input.url || "")}`;
  if (member === "find") return `🔎 finding "${input.query}"`;
  if (member === "type") return `⌨️ typing`;
  if (member === "get_page_text" || member === "read_page") return "📖 reading the page";
  if (member.includes("click")) return "🖱️ clicking";
  if (member === "scroll" || member === "scroll_to") return "↕️ scrolling";
  return `🌐 ${member.replace(/_/g, " ")}`;
}

// The continued session's most recent messages, as many as fit in one RPC reply.
function historyPayload() {
  const out = [];
  let size = 20;
  for (const m of [...history].reverse()) {
    const item = { who: m.who, text: m.text.slice(0, 2000) };
    size += new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (size > HISTORY_LIMIT_BYTES) break;
    out.unshift(item);
  }
  return JSON.stringify({ messages: out });
}

async function start({ tokenUrl, accessKey, session = { id: null, messages: [] }, volume: v = 1 }) {
  if (room) return;
  t0 = performance.now();
  volume = v;
  history = session.messages;
  const earlier = history.map((m) => ({ id: m.id, who: m.who, text: m.text, final: true, old: true }));
  state = { status: "connecting", session: session.id, messages: earlier.slice(-MAX_MESSAGES), steps: {}, muted: false,
            agentState: null, activity: null };
  publish();

  let cfg;
  try {
    // Cloudflare's Worker checks the access key (cloudflare/src/index.ts); docker compose's endpoint needs none.
    const r = await fetch(tokenUrl, { headers: accessKey ? { Authorization: `Bearer ${accessKey}` } : {} });
    if (r.status === 401) throw Object.assign(new Error("wrong or missing access key"), { key: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cfg = await r.json();
    step("token", true, `room ${cfg.room}`);
  } catch (e) {
    step("token", false, `${tokenUrl}: ${e.message}`);
    return patch({ status: "error", error: e.key ? "The agent service refused the access key: check it on the setup page."
                                                  : "Can't reach the agent service: is docker compose up, or the Worker deployed?" });
  }

  room = new Room();
  wire(room);
  step("connect", null, cfg.url);
  try {
    await room.connect(cfg.url, cfg.token);
    if (!room) return;  // hung up while connecting
    step("connect", true, `room ${room.name}`);
  } catch (e) {
    room = null;
    step("connect", false, e.message);
    return patch({ status: "error", error: `Couldn't connect: ${e.message}` });
  }
  patch({ status: "connected", room: room.name, error: null });
  room.startAudio().catch(() => {});

  step("mic", null, "opening the microphone");
  try {
    const pub = await room.localParticipant.setMicrophoneEnabled(true);
    step("mic", true, pub?.track?.mediaStreamTrack?.label || "published");
  } catch (e) {
    step("mic", false, `${e.name}: ${e.message}`);
    if (e.name === "NotAllowedError") {
      toSw({ event: "mic_denied" });
      patch({ error: "Microphone not allowed yet: allow it in the setup tab, then start again. You can still type." });
    }
  }

  setTimeout(() => {
    if (room?.state === "connected" && room.remoteParticipants.size === 0)
      step("agent_joined", false, "no agent after 10s: is the voice container running? (docker compose logs voice)");
  }, 10000);
  keepalive = setInterval(() => toSw({ cmd: "getState" }).catch(() => {}), KEEPALIVE_MS);
}

function wire(r) {
  // Only the agent may call into the browser, not other participants in the room.
  const requireAgent = (data, what) => {
    if (r.remoteParticipants.get(data.callerIdentity)?.kind !== ParticipantKind.AGENT)
      throw new RpcError(403, `Only the agent can ${what}.`);
  };

  // The agent streams transcripts of both sides; one whose lk.transcribed_track_id is our own
  // track is the user's speech.
  r.registerTextStreamHandler("lk.transcription", async (reader) => {
    const a = reader.info.attributes || {};
    const ours = [...r.localParticipant.trackPublications.keys()].includes(a["lk.transcribed_track_id"]);
    const id = a["lk.segment_id"] || reader.info.id;
    let text = "";
    for await (const chunk of reader) {
      text += chunk;
      say(id, ours ? "you" : "agent", text, a["lk.transcription_final"] === "true" || !ours);
    }
    say(id, ours ? "you" : "agent", text, true);
  });

  r.registerTextStreamHandler("lk.debug", async (reader) => {
    const m = JSON.parse(await reader.readAll());
    step(m.step, m.ok, m.detail);
  });

  r.registerRpcMethod(RPC_METHOD, async (data) => {
    requireAgent(data, "use the browser");
    const { member, input } = JSON.parse(data.payload);
    patch({ activity: activityLabel(member, input || {}) });
    try {
      return JSON.stringify(await toSw({ cmd: "tool", member, input }));
    } finally {
      patch({ activity: null });
    }
  });

  r.registerRpcMethod(HISTORY_METHOD, async (data) => {
    requireAgent(data, "read the history");
    return historyPayload();
  });

  r.registerRpcMethod(MEMORY_METHOD, async (data) => {
    requireAgent(data, "change memories");
    const { action, text, id } = JSON.parse(data.payload);
    if (!["list", "add", "remove"].includes(action)) throw new RpcError(400, `Unknown memory action ${action}.`);
    if (action !== "list") patch({ activity: action === "add" ? "🧠 remembering" : "🧠 forgetting" });
    try {
      return JSON.stringify(await toSw({ cmd: "memory", action, text, id }));
    } finally {
      if (action !== "list") patch({ activity: null });
    }
  });

  r.on(RoomEvent.ParticipantAttributesChanged, (changed) => {
    if (changed["lk.agent.state"]) patch({ agentState: changed["lk.agent.state"] });
  });
  r.on(RoomEvent.ParticipantConnected, (p) => step("agent_joined", null, `${p.identity} joined, starting…`));
  r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    patch({ userSpeaking: speakers.some((s) => s.identity === r.localParticipant.identity) });
  });

  let heard = false;
  r.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
    if (track.kind !== Track.Kind.Audio) return;
    document.body.appendChild(track.attach());
    track.setVolume(volume);
    step("playback", null, `receiving audio from ${participant.identity}`);
    const stats = setInterval(async () => {
      if (heard || r.state !== "connected") return clearInterval(stats);
      const s = await track.getReceiverStats?.();
      if (s?.totalAudioEnergy > 0.001) { heard = true; step("playback", true, "agent audio is playing"); }
    }, 500);
  });
  r.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if (!r.canPlaybackAudio) step("playback", false, "Chrome blocked audio playback");
  });
  r.on(RoomEvent.Disconnected, (reason) => {
    if (room === r) { room = null; clearInterval(keepalive); }
    step("connect", null, `left the call (${reason ?? "hung up"})`);
    patch(ENDED);
  });
}

async function stop() {
  const r = room;
  room = null;
  clearInterval(keepalive);
  if (r) await r.disconnect();
  patch(ENDED);
}

async function setMuted(muted) {
  if (!room) return;
  await room.localParticipant.setMicrophoneEnabled(!muted);
  patch({ muted });
}

async function setVolume(v) {
  volume = v;
  for (const p of room?.remoteParticipants.values() ?? [])
    for (const pub of p.audioTrackPublications.values()) pub.audioTrack?.setVolume(v);
}

// Typed messages go to the agent on "lk.chat"; it answers like a spoken turn.
async function sendText(text) {
  if (!room) return;
  say(`typed-${Date.now()}`, "you", text);
  await room.localParticipant.sendText(text, { topic: "lk.chat" });
}

// Commands from the service worker.
const COMMANDS = {
  start,
  stop,
  mute: (msg) => setMuted(msg.muted),
  volume: (msg) => setVolume(msg.volume),
  text: (msg) => sendText(msg.text),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.to !== "offscreen" || !Object.hasOwn(COMMANDS, msg.cmd)) return;
  COMMANDS[msg.cmd](msg).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
  return true;  // the reply comes asynchronously
});
})();
