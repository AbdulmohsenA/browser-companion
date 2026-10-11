// Content script: how the overlay looks (styles, icons and markup). Its behaviour is in overlay.js.
globalThis.LkOverlayUI = (() => {
const ICON = {
  mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>',
  micOff: '<svg viewBox="0 0 24 24"><path d="M19 11h-2a5 5 0 0 1-.7 2.55l1.46 1.46A6.96 6.96 0 0 0 19 11ZM15 11V5a3 3 0 0 0-5.94-.6L15 10.34V11ZM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.5 2.6l1.65 1.65A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 2.6-.93L19.73 21 21 19.73 4.27 3Z"/></svg>',
  end: '<svg viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.48a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1A15 15 0 0 0 12 9Z"/></svg>',
  history: '<svg viewBox="0 0 24 24"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3Zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12Z"/></svg>',
  memory: '<svg viewBox="0 0 24 24"><path d="M13 3a7 7 0 0 0-6.93 6.02L4.2 11.6c-.3.41-.02 1 .5 1H6v3a2 2 0 0 0 2 2h1v3h7v-4.68A7 7 0 0 0 13 3Zm3 9.6V18h-5v-3H8v-4.4l-.1-.07A5 5 0 1 1 16 12.6Z"/></svg>',
  min: '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>',
  bug: '<svg viewBox="0 0 24 24"><path d="M20 8h-2.81a5.98 5.98 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17a6 6 0 0 0-2.83 0L8.41 3 7 4.41l1.62 1.63A5.98 5.98 0 0 0 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81A6 6 0 0 0 17.2 18H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8Zm-6 8h-4v-2h4v2Zm0-4h-4v-2h4v2Z"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M3.4 20.4 20.85 12.9a1 1 0 0 0 0-1.84L3.4 3.6a.99.99 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91Z"/></svg>',
};

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: fixed; left: 12px; top: 8px; z-index: 2147483647; display: flex; flex-direction: column;
  align-items: flex-start; gap: 8px; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #eef0f6; }
svg { width: 20px; height: 20px; fill: currentColor; display: block; }
button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; }

.orb { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; position: relative;
  background: #2b2f3c; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.35); transition: background .2s, transform .15s; }
.orb:hover { transform: scale(1.06); }
.orb[hidden], .clippy[hidden] { display: none; }
.clippy { width: calc(124px * var(--s, 1)); height: calc(93px * var(--s, 1)); cursor: grab; touch-action: none;
  margin: 0 0 -6px calc(-32px * var(--s, 1)); }  /* the frame has blank space left of him */
.orb, .clippy { -webkit-user-select: none; user-select: none; }
.dragging .orb, .dragging .clippy { cursor: grabbing; }

/* Clippy's replies, in an Office 97 tooltip balloon. The tail points up at him. */
.bubble { position: absolute; left: 4px; width: max-content; max-width: 240px; padding: 6px 8px; background: #ffffe1; color: #000;
  border: 1px solid #000; border-radius: 8px; font: 12px/1.35 Tahoma, Verdana, "Segoe UI", sans-serif; cursor: default;
  opacity: 0; transition: opacity .3s; pointer-events: none; }
.bubble.show { opacity: 1; pointer-events: auto; }
.bubble::before, .bubble::after { content: ""; position: absolute; left: 18px; border: solid transparent; }
.bubble::before { bottom: 100%; border-width: 0 9px 12px; border-bottom-color: #000; }
.bubble::after { bottom: calc(100% - 1px); left: 19px; border-width: 0 8px 11px; border-bottom-color: #ffffe1; }
.bubble .btext { max-height: 180px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word; }

.menu { position: absolute; z-index: 1; left: 0; min-width: 210px; padding: 6px; border-radius: 12px; background: rgba(24, 26, 34, .98);
  border: 1px solid rgba(255,255,255,.1); box-shadow: 0 12px 40px rgba(0,0,0,.5); display: flex; flex-direction: column; gap: 2px; }
.menu[hidden] { display: none; }
.menu .item { text-align: left; padding: 7px 10px; border-radius: 8px; }
.menu .item:hover { background: rgba(255,255,255,.08); }
.menu .item[hidden] { display: none; }
.menu .item.danger { color: #fca5a5; }
.menu .field { padding: 6px 10px; display: flex; align-items: center; gap: 10px; font-size: 13px; color: #cbd5e1; }
.menu .field > span:first-child { width: 48px; }
.menu input[type=range] { flex: 1; min-width: 0; padding: 0; accent-color: #6366f1; background: none; }
.menu .vol { width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
.menu .sizes { display: flex; gap: 4px; }
.menu .sizes button { padding: 3px 8px; border-radius: 6px; background: #2b2f3c; font-size: 12px; }
.menu .sizes button.on { background: #4f46e5; color: #fff; }
.menu hr { border: 0; border-top: 1px solid rgba(255,255,255,.08); margin: 4px 0; width: 100%; }
.orb svg { width: 26px; height: 26px; }
.orb::after { content: ""; position: absolute; inset: -5px; border-radius: 50%; border: 3px solid transparent; }
.orb.connected { background: #4f46e5; }
.orb.listening.speaking::after { border-color: #34d399; animation: pulse 1s ease-in-out infinite; }
.orb.thinking::after { border-color: #fbbf24 transparent #fbbf24 transparent; animation: spin 1s linear infinite; }
.orb.agent-speaking::after { border-color: #a78bfa; animation: pulse .7s ease-in-out infinite; }
.orb.connecting::after { border-color: #94a3b8 transparent; animation: spin 1s linear infinite; }
.orb.error { background: #b91c1c; }
.orb.muted { background: #52525b; }
@keyframes pulse { 50% { transform: scale(1.12); opacity: .6; } }
@keyframes spin { to { transform: rotate(360deg); } }

.panel { width: 370px; max-width: calc(100vw - 24px); max-height: min(560px, calc(100vh - 120px)); display: flex;
  flex-direction: column; border-radius: 16px; overflow: hidden; background: rgba(24, 26, 34, .96);
  border: 1px solid rgba(255,255,255,.08); box-shadow: 0 12px 48px rgba(0,0,0,.45); backdrop-filter: blur(12px); }
.panel[hidden] { display: none; }
.head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 10px 16px; border-bottom: 1px solid rgba(255,255,255,.07); }
.title { flex: 1; min-width: 0; }
.status { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; flex: none; }
.dot.on { background: #34d399; } .dot.busy { background: #fbbf24; } .dot.bad { background: #f87171; }
.activity { font-size: 12px; color: #a5b4fc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 16px; }
.icon { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; color: #cbd5e1; flex: none; }
.icon:hover { background: rgba(255,255,255,.08); color: #fff; }
.icon.on { color: #fbbf24; }
.icon.hang { background: #dc2626; color: #fff; } .icon.hang:hover { background: #ef4444; }
.icon[hidden] { display: none; }

.error { margin: 10px 12px 0; padding: 8px 10px; border-radius: 10px; background: rgba(220,38,38,.18); color: #fecaca; font-size: 13px; }
.error[hidden] { display: none; }
.log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
.msg { max-width: 85%; padding: 8px 12px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; }
.msg.you { align-self: flex-end; background: #4f46e5; color: #fff; border-bottom-right-radius: 4px; }
.msg.agent { align-self: flex-start; background: #2b2f3c; border-bottom-left-radius: 4px; }
.msg.interim { opacity: .65; font-style: italic; }
.msg.old { opacity: .6; }
.divider { align-self: center; font-size: 11px; color: #94a3b8; padding: 2px 0; }
.hhead { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; }
.sess { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; background: #2b2f3c; }
.sess .info { flex: 1; min-width: 0; }
.sess .stitle { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess .fact { white-space: pre-wrap; word-wrap: break-word; }
.sess .smeta, .sess .tag { font-size: 12px; color: #94a3b8; }
.sess .go { padding: 5px 10px; border-radius: 8px; background: #4f46e5; color: #fff; font-size: 12px; font-weight: 600; flex: none; }
.sess .go:hover { background: #6366f1; }
.sess .del { width: 26px; height: 26px; border-radius: 8px; color: #94a3b8; flex: none; }
.sess .del:hover { background: rgba(255,255,255,.08); color: #fca5a5; }
.clear { align-self: center; font-size: 12px; color: #fca5a5; padding: 6px 10px; border-radius: 8px; }
.clear:hover { background: rgba(220,38,38,.15); }
.empty { margin: auto; text-align: center; color: #94a3b8; font-size: 13px; padding: 12px; }
.start { margin-top: 12px; padding: 10px 18px; border-radius: 999px; background: #4f46e5; color: #fff; font-weight: 600; }
.start:hover { background: #6366f1; }

.debug { padding: 8px 12px; border-top: 1px solid rgba(255,255,255,.07); max-height: 220px; overflow-y: auto; font-size: 12px; }
.debug[hidden] { display: none; }
.step { display: grid; grid-template-columns: 10px 120px 1fr auto; gap: 8px; align-items: center; padding: 3px 0; }
.step .dot { width: 8px; height: 8px; }
.step .detail { color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.step .t { color: #64748b; font-variant-numeric: tabular-nums; }

form { display: flex; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid rgba(255,255,255,.07); }
input { flex: 1; min-width: 0; font: inherit; color: #eef0f6; background: #2b2f3c; border: 1px solid transparent;
  border-radius: 10px; padding: 9px 12px; outline: none; }
input:focus { border-color: #6366f1; }
input:disabled { opacity: .5; }
form button { width: 40px; border-radius: 10px; background: #4f46e5; color: #fff; display: grid; place-items: center; }
form button:disabled { opacity: .4; cursor: default; }
`;

const HTML = `<style>${CSS}</style>
<div class="wrap">
  <button class="orb" title="Talk to the agent">${ICON.mic}</button>
  <canvas class="clippy" hidden></canvas>
  <div class="menu" hidden>
    <div class="field"><span>Volume</span><input type="range" class="volume" min="0" max="100"><span class="vol"></span></div>
    <div class="field"><span>Size</span><div class="sizes">
      <button data-size="small">S</button><button data-size="normal">M</button><button data-size="large">L</button>
    </div></div>
    <hr>
    <button class="item m-panel"></button>
    <button class="item m-mute"></button>
    <button class="item m-call"></button>
    <button class="item m-setup">Settings…</button>
  </div>
  <div class="bubble" title="Click to close"><div class="btext"></div></div>
  <section class="panel" hidden>
    <div class="head">
      <div class="title">
        <div class="status"><span class="dot"></span><span class="label">Not connected</span></div>
        <div class="activity"></div>
      </div>
      <button class="icon mute" title="Mute microphone" hidden>${ICON.mic}</button>
      <button class="icon mem" title="What Sarjy remembers about you">${ICON.memory}</button>
      <button class="icon hist" title="Earlier conversations">${ICON.history}</button>
      <button class="icon dbg" title="Show pipeline steps">${ICON.bug}</button>
      <button class="icon min" title="Minimize">${ICON.min}</button>
      <button class="icon hang" title="End the call" hidden>${ICON.end}</button>
    </div>
    <div class="error" hidden></div>
    <div class="log"></div>
    <div class="debug" hidden></div>
    <form><input placeholder="Type a message…" disabled><button disabled title="Send">${ICON.send}</button></form>
  </section>
</div>`;

return { ICON, HTML };
})();
