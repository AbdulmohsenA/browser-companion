// Session history for the service worker, kept in chrome.storage.local (this browser only).
// Each call is a session. Its finished messages are saved as they arrive (the overlay's state only keeps
// the last 60), and a past session can be continued: the overlay shows it again, and the agent asks for it
// over RPC when it joins (offscreen.js "history", voice/agent.py).
//   "sessions"     -> [{id, title, started, updated, count}], newest first
//   "session:<id>" -> [{id, who, text, t}]
// A call where you never said anything isn't kept.

const MAX_SESSIONS = 50;
const MAX_SESSION_MESSAGES = 500;
const TITLE_CHARS = 70;

const Sessions = {
  newId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6),

  async list() {
    return (await chrome.storage.local.get("sessions")).sessions || [];
  },

  async messages(id) {
    return (await chrome.storage.local.get("session:" + id))["session:" + id] || [];
  },

  async remove(id) {
    const list = (await this.list()).filter((s) => s.id !== id);
    await chrome.storage.local.set({ sessions: list });
    await chrome.storage.local.remove("session:" + id);
  },

  async clear() {
    const list = await this.list();
    await chrome.storage.local.remove(["sessions", ...list.map((s) => "session:" + s.id)]);
  },

  _saving: Promise.resolve(),
  _last: "",  // signature of the last saved messages, to skip the many updates that change nothing

  /** Saves the call's finished messages; called with every state update. */
  record(state) {
    const id = state.session;
    const finals = (state.messages || []).filter((m) => m.final);
    const sig = id + "|" + finals.map((m) => m.id + ":" + m.text.length).join(",");
    if (!id || sig === this._last) return;
    this._last = sig;
    this._saving = this._saving.then(() => this._save(id, finals)).catch((e) => console.warn("session save", e));
  },

  async _save(id, finals) {
    const stored = await this.messages(id);
    let changed = false;
    for (const m of finals) {
      const old = stored.find((s) => s.id === m.id);
      if (!old) { stored.push({ id: m.id, who: m.who, text: m.text, t: Date.now() }); changed = true; }
      else if (old.text !== m.text) { old.text = m.text; changed = true; }
    }
    const firstYou = stored.find((m) => m.who === "you");
    if (!changed || !firstYou) return;

    const list = await this.list();
    const entry = list.find((s) => s.id === id) || { id, started: stored[0].t };
    Object.assign(entry, { title: firstYou.text.slice(0, TITLE_CHARS), updated: Date.now(), count: stored.length });
    const next = [entry, ...list.filter((s) => s.id !== id)];
    const dropped = next.splice(MAX_SESSIONS);
    await chrome.storage.local.set({ sessions: next, ["session:" + id]: stored.slice(-MAX_SESSION_MESSAGES) });
    if (dropped.length) await chrome.storage.local.remove(dropped.map((s) => "session:" + s.id));
  },
};
