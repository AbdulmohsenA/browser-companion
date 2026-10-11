const MAX_MEMORIES = 50;   // they all go into the agent's instructions on every call
const MEMORY_CHARS = 200;

const Memory = {
  async list() {
    return (await chrome.storage.local.get("memories")).memories || [];
  },

  /** {action: "list" | "add" | "remove" | "clear", text?, id?} -> {facts: [{id, text}], id?} or {error} */
  async handle({ action, text, id }) {
    let list = await this.list(), added = null;
    if (action === "add") {
      text = String(text || "").trim().slice(0, MEMORY_CHARS);
      if (!text) return { error: "Nothing to remember." };
      added = list.find((m) => m.text.toLowerCase() === text.toLowerCase());
      if (!added) {
        if (list.length >= MAX_MEMORIES)
          return { error: `Memory is full (${MAX_MEMORIES} facts). Ask the user which one to forget.` };
        const { memoryNext = 1 } = await chrome.storage.local.get("memoryNext");
        added = { id: "m" + memoryNext, text, t: Date.now() };
        list = [...list, added];
        await chrome.storage.local.set({ memories: list, memoryNext: memoryNext + 1 });
      }
    } else if (action === "remove") {
      if (!list.some((m) => m.id === id)) return { error: `There's no memory ${id}.` };
      list = list.filter((m) => m.id !== id);
      await chrome.storage.local.set({ memories: list });
    } else if (action === "clear") {
      list = [];
      await chrome.storage.local.set({ memories: list });
    } else if (action !== "list") {
      return { error: `Unknown memory action ${action}.` };
    }
    return { facts: list.map(({ id, text }) => ({ id, text })), ...(added && { id: added.id }) };
  },
};
