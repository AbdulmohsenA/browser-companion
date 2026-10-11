// Content script: Clippy for the overlay, with two animations: "normal" (resting, blinking now and then) and
// "talking" (raising his brows while the agent speaks). A local placeholder (see clippy/NOTICE.txt); without
// the clippy/ folder the overlay keeps its round button.
//
// Sprite strips come through the service worker (pages can't load extension files without
// web_accessible_resources, which would let any site detect the extension).
(() => {
if (globalThis.LkClippy) return;

const W = 124, H = 93, PER_ROW = 16;  // frame size and tiles per row in the strips

// Each animation: the strip it uses and its frames as [tile, ms]; it loops. A [min, max] ms is a random hold.
const ANIMATIONS = {
  normal: { strip: "Idle1_1", frames: [[0, [2500, 6000]], [1, 80], [2, 120], [1, 80]] },  // blink
  talking: { strip: "Explain", frames: [[0, 120], [1, 100], [2, 100], [3, [300, 700]], [2, 100], [1, 100]] },
};

globalThis.LkClippy = class {
  constructor(canvas, send) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.send = send;
    this.strips = {};
    this.name = "normal";
    this.index = 0;
    this.timer = null;
    [canvas.width, canvas.height] = [W, H];
  }

  async load() {
    try {
      for (const [name, a] of Object.entries(ANIMATIONS)) this.strips[name] = await this.strip(a.strip);
    } catch { return false; }
    this.wake();
    return true;
  }

  async strip(name) {
    const b64 = await this.send({ cmd: "clippyAsset", name: name + ".png" });
    if (!b64) throw new Error("missing " + name);
    return createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" }));
  }

  /** "normal" or "talking"; switching starts the new one from its first frame. */
  play(name) {
    if (name === this.name) return;
    this.name = name;
    this.index = 0;
    if (this.timer) { this.pause(); this.wake(); }
  }

  /** (Re)starts the frame timer; it stops while the tab or the overlay is hidden. */
  wake() {
    if (!this.timer && !document.hidden && this.strips.normal) this.step();
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  step() {
    if (document.hidden) { this.timer = null; return; }
    const { frames } = ANIMATIONS[this.name];
    const [tile, ms] = frames[this.index];
    this.ctx.clearRect(0, 0, W, H);
    this.ctx.drawImage(this.strips[this.name], (tile % PER_ROW) * W, Math.floor(tile / PER_ROW) * H, W, H, 0, 0, W, H);
    this.index = (this.index + 1) % frames.length;
    this.timer = setTimeout(() => this.step(), Array.isArray(ms) ? ms[0] + Math.random() * (ms[1] - ms[0]) : ms);
  }
};
})();
