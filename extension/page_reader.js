// Content script. Builds the accessibility-style outline that read_page and find return, in
// Claude's browser-tool format:   link "Getting started" [ref_2]
// Refs are stored on the elements (data-lk-ref), so they stay valid until the DOM node goes away.
// The overlay lives in a closed shadow root, so neither read_page nor find can see it.
globalThis.lkPageReader = (args) => {
  const { mode, filter, depth, ref, query } = args;
  window.__lkRefCount = window.__lkRefCount || 0;

  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION"]);
  const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch",
    "textbox", "combobox", "searchbox", "slider", "spinbutton", "menuitemcheckbox", "menuitemradio", "treeitem"]);
  const LANDMARKS = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", FORM: "form",
    UL: "list", OL: "list", LI: "listitem", TABLE: "table", TR: "row", TD: "cell", TH: "columnheader",
    P: "paragraph", DIALOG: "dialog", IFRAME: "iframe", SECTION: "region", ARTICLE: "article", ASIDE: "complementary" };
  // Roles whose name is their own text (others would repeat all their children's text).
  const TEXT_ROLES = new Set(["heading", "paragraph", "cell", "columnheader", "listitem", "img", "option"]);
  // Structural roles shown in the outline even without a name.
  const CONTAINER_ROLES = new Set(["navigation", "main", "form", "list", "table", "dialog", "region", "article", "banner",
    "contentinfo", "complementary"]);
  const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "svg"]);
  const LIMIT = 50000;  // characters of outline
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const squash = (s) => (s || "").replace(/\s+/g, " ").trim();

  function role(el) {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName;
    if (t === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "INPUT") {
      const ty = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox" || ty === "radio") return ty;
      if (ty === "range") return "slider";
      if (ty === "search") return "searchbox";
      if (ty === "hidden") return "none";
      return "textbox";
    }
    if (t === "TEXTAREA") return "textbox";
    if (t === "SELECT") return "combobox";
    if (t === "OPTION") return "option";
    if (/^H[1-6]$/.test(t)) return "heading";
    if (t === "IMG") return el.alt ? "img" : "none";
    return LANDMARKS[t] || "generic";
  }

  function labelFor(el) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return squash(lab.innerText);
    }
    const wrap = el.closest("label");
    return wrap ? squash(wrap.innerText) : "";
  }

  function name(el, r) {
    const aria = el.getAttribute("aria-label");
    if (aria) return squash(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const s = squash(by.split(/\s+/).map((i) => document.getElementById(i)?.innerText || "").join(" "));
      if (s) return s;
    }
    if (el.tagName === "IMG") return squash(el.alt);
    if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
      if (["button", "submit", "reset"].includes(el.type)) return squash(el.value);
      return labelFor(el) || squash(el.placeholder || el.title || el.name || "");
    }
    if (INTERACTIVE_ROLES.has(r) || TEXT_ROLES.has(r)) return squash(el.innerText || el.textContent) || squash(el.title);
    return "";
  }

  function interactive(el, r) {
    if (INTERACTIVE_ROLES.has(r)) return true;
    if (INTERACTIVE_TAGS.has(el.tagName) && r !== "generic" && r !== "none") return true;
    return el.hasAttribute("onclick") || el.isContentEditable || el.getAttribute("tabindex") === "0";
  }

  function visible(el) {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  }
  const inViewport = (el) => {
    const b = el.getBoundingClientRect();
    return b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth;
  };

  function refOf(el) {
    let r = el.getAttribute("data-lk-ref");
    if (!r) { r = "ref_" + ++window.__lkRefCount; el.setAttribute("data-lk-ref", r); }
    return r;
  }

  function line(el, r, n) {
    let s = `${r}${n ? ` "${clip(n, 100)}"` : ""} [${refOf(el)}]`;
    if (r === "heading") s += ` (level ${el.tagName[1] || el.getAttribute("aria-level") || "?"})`;
    if (["textbox", "searchbox", "combobox", "slider"].includes(r) && el.value) s += ` value="${clip(String(el.value), 60)}"`;
    if ((r === "checkbox" || r === "radio") && el.checked) s += " (checked)";
    if (el.disabled) s += " (disabled)";
    if (r === "link" && el.href && !el.href.startsWith("javascript:")) s += ` -> ${clip(el.href, 80)}`;
    return s;
  }

  // ---- find: rank interactive elements and headings by word overlap with the query ----
  if (mode === "find") {
    const words = squash(query).toLowerCase().split(/\W+/).filter((w) => w.length > 1);
    const hits = [];
    for (const el of document.querySelectorAll("*")) {
      const r = role(el);
      if (!(interactive(el, r) || r === "heading") || !visible(el)) continue;
      const n = name(el, r);
      const hay = `${r} ${n} ${el.placeholder || ""} ${el.name || ""} ${el.id || ""}`.toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      if (score > 0) hits.push([score + (inViewport(el) ? 0.5 : 0), line(el, r, n)]);
    }
    hits.sort((a, b) => b[0] - a[0]);
    return hits.slice(0, 20).map((h) => h[1]).join("\n") || `No elements match "${query}".`;
  }

  // ---- read_page ----
  let root = document.body;
  if (ref) {
    root = document.querySelector(`[data-lk-ref="${CSS.escape(ref)}"]`);
    if (!root) return `Error: ${ref} is stale or not found on the current page. Re-read the page to get fresh references.`;
  }
  const out = [];
  let chars = 0;

  function walk(el, level, indent) {
    if (chars > LIMIT || level > depth) return;
    for (const child of el.children) {
      if (SKIPPED_TAGS.has(child.tagName)) continue;
      if (!visible(child) && child.tagName !== "OPTION") continue;
      const r = role(child);
      if (r === "none") continue;
      const isInteractive = interactive(child, r);
      const n = name(child, r);
      // filter "interactive": controls only, anywhere; "all": everything; otherwise what's on screen.
      let show = filter === "interactive" ? isInteractive
        : isInteractive || (r !== "generic" && Boolean(n || CONTAINER_ROLES.has(r)));
      if (show && filter !== "all" && filter !== "interactive" && !inViewport(child)) show = false;
      if (show) {
        const text = "  ".repeat(filter === "interactive" ? 0 : indent) + line(child, r, n);
        out.push(text);
        chars += text.length + 1;
      }
      // An interactive element's or text role's name already covers its contents.
      if (!(isInteractive || TEXT_ROLES.has(r))) walk(child, level + 1, show ? indent + 1 : indent);
    }
  }
  walk(root, 1, 0);
  let text = out.join("\n");
  if (chars > LIMIT) text = text.slice(0, LIMIT) + "\n[Output truncated at 50,000 characters.]";
  return text || "(no matching elements on the visible page; try filter \"all\" or scroll)";
};
