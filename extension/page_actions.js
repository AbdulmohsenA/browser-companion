// Content script: carries out the agent's in-page actions (clicks, typing, keys, scrolling, forms,
// reading). The service worker sends {to: "page", member, input} and gets back {text, ...}.
//
// Events are synthetic (dispatched from here), so the browser doesn't apply its own default
// actions for them: this file applies the common ones itself (focus on click, Enter submits a
// form, Backspace deletes, Tab moves focus, arrows/PageDown scroll). That works on almost all
// sites; a site that only trusts real input would need the debugger permission instead.
(() => {
if (globalThis.lkPageActionsLoaded) return;  // the service worker may inject this file again
globalThis.lkPageActionsLoaded = true;

const OVERLAY_HOST_ID = "lk-voice-overlay-host";  // see overlay.js
const SCROLL_STEP_PX = 100;  // one unit of scroll_amount, as in Claude's tool
const GET_TEXT_LIMIT = 20000;
const STALE = (ref) => `Error: ${ref} is stale or not found on the current page. Re-read the page to get fresh references.`;

class ToolError extends Error {}

// xdotool-style names Claude uses -> DOM KeyboardEvent.key values
const KEY_NAMES = {
  ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", cmd: "Meta", meta: "Meta", super: "Meta",
  win: "Meta", enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", space: " ",
  backspace: "Backspace", delete: "Delete", del: "Delete", home: "Home", end: "End", pageup: "PageUp",
  page_up: "PageUp", pagedown: "PageDown", page_down: "PageDown", up: "ArrowUp", down: "ArrowDown",
  left: "ArrowLeft", right: "ArrowRight", insert: "Insert",
};
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (x, y) => `(${Math.round(x)}, ${Math.round(y)})`;

// ---------------------------------------------------------------- targets
function byRef(ref) {
  const el = document.querySelector(`[data-lk-ref="${CSS.escape(ref)}"]`);
  if (!el) throw new ToolError(STALE(ref));
  return el;
}

// The topmost page element at a point, looking through the overlay.
function elementAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) if (el.id !== OVERLAY_HOST_ID) return deepElementAt(el, x, y);
  return document.documentElement;
}
function deepElementAt(el, x, y) {
  // Open shadow roots (web components) hold the real target.
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

// {el, x, y} for a CoordinateTarget or the centre of a RefTarget's element.
function resolve(target) {
  if (!target) throw new ToolError("target is required");
  if (target.type === "coordinate") {
    const x = Number(target.x), y = Number(target.y);
    return { el: elementAt(x, y), x, y };
  }
  if (target.type === "ref") {
    const el = byRef(target.ref);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) throw new ToolError(`${target.ref} is not visible, so it can't be clicked.`);
    return { el, x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  throw new ToolError('target.type must be "coordinate" or "ref"');
}

function deepActive() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

const isTextField = (el) =>
  el && ((el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color"]
    .includes((el.type || "text").toLowerCase())) || el.tagName === "TEXTAREA");
const isEditable = (el) => el && (isTextField(el) || el.isContentEditable);

// ---------------------------------------------------------------- events
function mods(modifiers) {
  const m = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  for (const part of (modifiers || "").toLowerCase().split(/[+\s]+/).filter(Boolean)) {
    const k = KEY_NAMES[part] || part;
    if (k === "Control") m.ctrlKey = true;
    if (k === "Alt") m.altKey = true;
    if (k === "Shift") m.shiftKey = true;
    if (k === "Meta") m.metaKey = true;
  }
  return m;
}

function mouse(type, el, x, y, extra = {}) {
  const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y,
                 screenX: x + screenX, screenY: y + screenY, ...extra };
  const Ctor = type.startsWith("pointer") ? PointerEvent : type.startsWith("drag") || type === "drop" ? DragEvent : MouseEvent;
  if (Ctor === PointerEvent) Object.assign(init, { pointerId: 1, pointerType: "mouse", isPrimary: true });
  return el.dispatchEvent(new Ctor(type, init));
}

// A pointer event and its mouse twin ("down": pointerdown, then mousedown). False if either was cancelled.
function pointer(phase, el, x, y, extra = {}) {
  const a = mouse("pointer" + phase, el, x, y, extra);
  const b = mouse("mouse" + phase, el, x, y, extra);
  return a && b;
}

function focusFor(el) {
  // A real mousedown focuses the nearest focusable ancestor; synthetic ones don't.
  const f = el.closest("input, textarea, select, button, a[href], [tabindex], [contenteditable=''], [contenteditable=true]");
  if (f && f !== document.activeElement) f.focus({ preventScroll: true });
}

function linkOf(el) {
  const a = el.closest("a[href]");
  return a && /^https?:/.test(a.href) ? a.href : null;
}

function click(input, button = 0, count = 1) {
  const { el, x, y } = resolve(input.target);
  const m = mods(input.modifiers);
  const what = input.target.type === "ref" ? `element ${input.target.ref}` : at(x, y);
  // Ctrl/Cmd-click or middle-click on a link opens it in a new tab (done by the service worker).
  const href = linkOf(el);
  if (href && (button === 1 || (button === 0 && (m.ctrlKey || m.metaKey)))) {
    return { text: `Opened ${what} in a new tab.`, open_tab: href };
  }
  const buttons = [1, 4, 2][button];
  pointer("over", el, x, y, m);
  pointer("move", el, x, y, m);
  for (let i = 1; i <= count; i++) {
    if (pointer("down", el, x, y, { ...m, button, buttons, detail: i }) && button === 0) focusFor(el);
    pointer("up", el, x, y, { ...m, button, detail: i });
    if (button === 0) mouse("click", el, x, y, { ...m, button, detail: i });  // links, checkboxes, submit run on this
    else if (button === 1) mouse("auxclick", el, x, y, { ...m, button, detail: i });
  }
  if (button === 2) mouse("contextmenu", el, x, y, { ...m, button });
  if (count >= 2) mouse("dblclick", el, x, y, { ...m, detail: 2 });
  if (count === 2 && isTextField(el)) selectWordAt(el);
  if (count === 3) {
    if (isTextField(el)) el.select();
    else { const r = document.createRange(); r.selectNodeContents(el.closest("p, li, td, div") || el);
           getSelection().removeAllRanges(); getSelection().addRange(r); }
  }
  const verb = button === 2 ? "Right-clicked" : button === 1 ? "Middle-clicked" : ["", "Clicked", "Double-clicked", "Triple-clicked"][count];
  return `${verb} ${what}.`;
}

function selectWordAt(el) {
  const v = el.value, i = el.selectionStart ?? v.length;
  let a = i, b = i;
  while (a > 0 && /\w/.test(v[a - 1])) a--;
  while (b < v.length && /\w/.test(v[b])) b++;
  el.setSelectionRange(a, b);
}

function hover(input) {
  const { el, x, y } = resolve(input.target);
  for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) mouse(t, el, x, y);
  return `Hovering at ${at(x, y)}.`;
}

let pressed = null;  // element under left_mouse_down, for left_mouse_up
function mouseDown(input) {
  const { el, x, y } = resolve(input.target);
  pointer("down", el, x, y, { button: 0, buttons: 1 });
  focusFor(el);
  pressed = el;
  return `Mouse down at ${at(x, y)}.`;
}
function mouseUp(input) {
  const { el, x, y } = resolve(input.target);
  pointer("up", el, x, y, { button: 0 });
  if (pressed === el) mouse("click", el, x, y, { button: 0, detail: 1 });
  pressed = null;
  return `Mouse up at ${at(x, y)}.`;
}
function mouseMove(input) {
  const { el, x, y } = resolve(input.target);
  pointer("move", el, x, y, { buttons: pressed ? 1 : 0 });
  return `Mouse moved to ${at(x, y)}.`;
}

async function drag(input) {
  const a = resolve(input.from), b = resolve(input.target);
  const source = a.el.closest("[draggable=true]");
  pointer("down", a.el, a.x, a.y, { button: 0, buttons: 1 });
  const dt = source ? new DataTransfer() : null;
  if (source) mouse("dragstart", source, a.x, a.y, { dataTransfer: dt });
  const STEPS = 12;
  let over = a.el;
  for (let i = 1; i <= STEPS; i++) {
    const x = a.x + ((b.x - a.x) * i) / STEPS, y = a.y + ((b.y - a.y) * i) / STEPS;
    over = elementAt(x, y);
    pointer("move", over, x, y, { buttons: 1 });
    if (source) { mouse("dragenter", over, x, y, { dataTransfer: dt }); mouse("dragover", over, x, y, { dataTransfer: dt }); }
    await sleep(15);
  }
  if (source) { mouse("drop", over, b.x, b.y, { dataTransfer: dt }); mouse("dragend", source, b.x, b.y, { dataTransfer: dt }); }
  pointer("up", over, b.x, b.y, { button: 0 });
  return `Dragged from ${at(a.x, a.y)} to ${at(b.x, b.y)}.`;
}

// ---------------------------------------------------------------- scrolling
function scroller(el, dx, dy) {
  // The nearest ancestor that can still scroll in this direction, else the page.
  for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    const s = getComputedStyle(e);
    const canY = dy && /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight
      && (dy > 0 ? e.scrollTop + e.clientHeight < e.scrollHeight - 1 : e.scrollTop > 0);
    const canX = dx && /(auto|scroll|overlay)/.test(s.overflowX) && e.scrollWidth > e.clientWidth
      && (dx > 0 ? e.scrollLeft + e.clientWidth < e.scrollWidth - 1 : e.scrollLeft > 0);
    if (canY || canX) return e;
  }
  return document.scrollingElement || document.documentElement;
}

function scroll(input) {
  const target = input.target || { type: "coordinate", x: innerWidth / 2, y: innerHeight / 2 };
  const { el, x, y } = resolve(target);
  const dir = input.scroll_direction || "down";
  const amount = Math.max(1, Math.min(10, Number(input.scroll_amount) || 3));
  const [ux, uy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir] || [0, 1];
  const dx = ux * amount * SCROLL_STEP_PX, dy = uy * amount * SCROLL_STEP_PX;
  // Sites with custom scrolling (maps, carousels) handle the wheel event and cancel it.
  const notHandled = el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, composed: true,
    clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0 }));
  if (notHandled) scroller(el, dx, dy).scrollBy({ left: dx, top: dy, behavior: "instant" });
  return `Scrolled ${dir} by ${amount} at ${at(x, y)}.`;
}

function scrollTo(input) {
  const ref = input.target?.ref;
  if (!ref) throw new ToolError('scroll_to needs a ref target: {"type": "ref", "ref": "ref_N"}');
  byRef(ref).scrollIntoView({ block: "center", behavior: "instant" });
  return `Scrolled ${ref} into view.`;
}

// ---------------------------------------------------------------- keyboard
function insertText(el, text) {
  // execCommand keeps the page's undo stack and fires the input events frameworks listen for.
  if (document.execCommand("insertText", false, text)) return;
  if (isTextField(el)) {
    el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  }
}

function keyInit(key, m) {
  const code = key.length === 1 ? (/[a-z]/i.test(key) ? "Key" + key.toUpperCase() : /\d/.test(key) ? "Digit" + key : "")
    : key === " " ? "Space" : key;
  return { key, code, bubbles: true, cancelable: true, composed: true, ...m };
}

async function type(input) {
  const el = deepActive();
  const text = String(input.text ?? "");
  if (!isEditable(el)) throw new ToolError("Nothing to type into: click a text field first.");
  if (text.length > 200) insertText(el, text);  // long text in one go
  else for (const ch of text) {
    const init = keyInit(ch, {});
    const ok = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (ok && el.dispatchEvent(new KeyboardEvent("keypress", init))) insertText(el, ch);
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  return `Typed ${text.length} characters.`;
}

function focusables() {
  return [...document.querySelectorAll("a[href], button, input, select, textarea, [tabindex], [contenteditable=true]")]
    .filter((e) => e.tabIndex >= 0 && !e.disabled && e.getClientRects().length && e.id !== OVERLAY_HOST_ID);
}

// What the browser would do for a key nobody cancelled.
function defaultAction(el, key, m) {
  const editable = isEditable(el);
  if (key === "Enter") {
    if (el.tagName === "INPUT" && el.form && isTextField(el)) return el.form.requestSubmit();
    if (el.tagName === "TEXTAREA" || el.isContentEditable) return insertText(el, "\n");
    if (/^(A|BUTTON|SUMMARY)$/.test(el.tagName) || el.getAttribute("role") === "button") return el.click();
    return;
  }
  if (key === " " && !editable && (el.tagName === "BUTTON" || el.getAttribute("role") === "button")) return el.click();
  if (key === "Backspace" && editable) return document.execCommand("delete");
  if (key === "Delete" && editable) return document.execCommand("forwardDelete");
  if (key === "Tab") {
    const list = focusables(), i = list.indexOf(el);
    const next = list[(i + (m.shiftKey ? -1 : 1) + list.length) % list.length];
    return next?.focus();
  }
  if ((m.ctrlKey || m.metaKey) && key.toLowerCase() === "a") {
    if (isTextField(el)) return el.select();
    return document.execCommand("selectAll");
  }
  if (m.ctrlKey || m.metaKey || m.altKey) return;
  if (key.length === 1 && editable) return insertText(el, key);
  if (!editable) {
    const page = document.scrollingElement, h = innerHeight * 0.9;
    const dy = { ArrowDown: 40, ArrowUp: -40, PageDown: h, PageUp: -h, " ": m.shiftKey ? -h : h }[key];
    if (dy) return scroller(el, 0, dy).scrollBy({ top: dy, behavior: "instant" });
    if (key === "Home") return page.scrollTo({ top: 0, behavior: "instant" });
    if (key === "End") return page.scrollTo({ top: page.scrollHeight, behavior: "instant" });
  }
}

function parseCombo(combo) {
  const parts = combo.split("+");
  const key = parts.pop();
  return { key: KEY_NAMES[key.toLowerCase()] || key, m: mods(parts.join("+")) };
}

function pressCombo(combo) {
  const el = deepActive() || document.body;
  const { key, m } = parseCombo(combo);
  const init = keyInit(key, m);
  const ok = el.dispatchEvent(new KeyboardEvent("keydown", init));
  if (ok && !MODIFIER_KEYS.has(key)) {
    if (key.length === 1 || key === "Enter") el.dispatchEvent(new KeyboardEvent("keypress", init));
    defaultAction(el, key, m);
  }
  el.dispatchEvent(new KeyboardEvent("keyup", init));
}

function key(input) {
  const repeat = Math.max(1, Math.min(100, Number(input.repeat) || 1));
  const combos = String(input.text || "").split(/\s+/).filter(Boolean);
  if (!combos.length) throw new ToolError("text is required, e.g. \"Enter\" or \"ctrl+a\"");
  for (let i = 0; i < repeat; i++) for (const c of combos) pressCombo(c);
  return `Pressed ${input.text}` + (repeat > 1 ? ` x${repeat}.` : ".");
}

async function holdKey(input) {
  const el = deepActive() || document.body;
  const { key, m } = parseCombo(String(input.text || ""));
  const secs = Math.max(0, Math.min(30, Number(input.duration) || 0));
  const init = keyInit(key, m);
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  // A held key auto-repeats about 30 times a second.
  const until = Date.now() + secs * 1000;
  await sleep(500);
  while (Date.now() < until) { el.dispatchEvent(new KeyboardEvent("keydown", { ...init, repeat: true })); await sleep(33); }
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  return `Held ${input.text} for ${secs}s.`;
}

// ---------------------------------------------------------------- forms and reading
function formInput(input) {
  const ref = input.target?.ref;
  if (!ref) throw new ToolError('form_input needs a ref target: {"type": "ref", "ref": "ref_N"}');
  const el = byRef(ref);
  const value = input.value;
  const fire = () => { el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  if (el.tagName === "SELECT") {
    const want = String(value).trim().toLowerCase();
    const opt = [...el.options].find((o) => o.label.trim().toLowerCase() === want || o.value.toLowerCase() === want)
             || [...el.options].find((o) => o.label.toLowerCase().includes(want));
    if (!opt) throw new ToolError(`No option "${value}" in ${ref}. Options: ${[...el.options].map((o) => o.label.trim()).join(", ").slice(0, 300)}`);
    el.value = opt.value;
    fire();
    return `Set ${ref} to ${JSON.stringify(opt.label.trim())}.`;
  }
  if (el.type === "checkbox" || el.type === "radio") {
    const want = typeof value === "string" ? ["true", "on", "1", "yes"].includes(value.toLowerCase()) : Boolean(value);
    if (el.checked !== want) el.click();  // a click so the page's own handlers run
    return `Set ${ref} to ${want}.`;
  }
  el.focus({ preventScroll: true });
  if (isTextField(el)) {
    // The prototype's setter, so React-style controlled inputs notice the change.
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
  } else if (el.isContentEditable) {
    el.textContent = String(value);
  } else {
    throw new ToolError(`${ref} is not a form field.`);
  }
  fire();
  return `Set ${ref} to ${JSON.stringify(value)}.`;
}

function pageText() {
  const main = document.querySelector("main, article, [role=main]") || document.body;
  let text = main.innerText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > GET_TEXT_LIMIT) text = text.slice(0, GET_TEXT_LIMIT) + `\n[Truncated at ${GET_TEXT_LIMIT} characters.]`;
  return `${document.title} (${location.href})\n\n${text}`;
}

// ---------------------------------------------------------------- dispatch
const MEMBERS = {
  left_click: (i) => click(i, 0, 1),
  right_click: (i) => click(i, 2, 1),
  middle_click: (i) => click(i, 1, 1),
  double_click: (i) => click(i, 0, 2),
  triple_click: (i) => click(i, 0, 3),
  hover, left_click_drag: drag, left_mouse_down: mouseDown, left_mouse_up: mouseUp, mouse_move: mouseMove,
  scroll, scroll_to: scrollTo, type, key, hold_key: holdKey, form_input: formInput,
  read_page: (i) => globalThis.lkPageReader({ mode: "read", filter: i.filter, depth: Number(i.depth) || 15, ref: i.ref }),
  find: (i) => globalThis.lkPageReader({ mode: "find", query: i.query || "" }),
  get_page_text: pageText,
  viewport: () => ({ text: `${innerWidth}x${innerHeight}`, width: innerWidth, height: innerHeight }),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.to !== "page") return;
  const fn = Object.hasOwn(MEMBERS, msg.member) && MEMBERS[msg.member];
  (async () => {
    if (!fn) throw new ToolError(`Unknown page action: ${msg.member}`);
    const r = await fn(msg.input || {});
    return typeof r === "string" ? { text: r } : r;
  })().then(reply, (e) => reply({ text: e instanceof ToolError ? e.message : `${e.name}: ${e.message}`, is_error: true }));
  return true;  // the reply comes asynchronously
});
})();
