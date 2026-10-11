// Service worker: opens the Smart Find panel in the current tab and runs searches for it.
// Jev calls happen here because the API key lives in extension storage and the content
// script's requests would be subject to the page's CORS rules.

import { scoreBatches, BATCH_SIZE } from "./jev.js";

const PRICE_PER_M = 0.042;
// question + passage text -> score, so repeated or refined searches skip work already done.
// Lives only as long as the service worker does, which is fine for a cache.
const cache = new Map();
const MAX_CACHE = 20_000;

async function openPanel(tab) {
  if (!tab?.id || !/^https?:|^file:/.test(tab.url ?? "")) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
}

// Local development convenience: if extension/dev-key.json exists (it is gitignored), use its
// key until one is saved in the options page.
// On first install without a key, open the options page so new users know where to put it.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (apiKey) return;
  try {
    const res = await fetch(chrome.runtime.getURL("dev-key.json"));
    const { apiKey: devKey } = await res.json();
    if (devKey) return chrome.storage.local.set({ apiKey: devKey });
  } catch {
    // no dev key file
  }
  if (reason === "install") chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(openPanel);
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-smart-find") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  openPanel(tab);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "open-options") chrome.runtime.openOptionsPage();
});

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "smart-find") return;
  let controller = null;

  port.onDisconnect.addListener(() => controller?.abort());
  port.onMessage.addListener(async (msg) => {
    if (msg.type === "cancel") return controller?.abort();
    if (msg.type !== "search") return;

    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const { seq, title, question, passages } = msg;
    const send = (m) => {
      if (!signal.aborted) {
        try { port.postMessage({ seq, ...m }); } catch {}
      }
    };

    const { apiKey } = await chrome.storage.local.get("apiKey");
    if (!apiKey) return send({ type: "error", code: "no-key", message: "Add your TypeSafe API key to start searching." });

    const started = performance.now();
    const keyOf = (p) => `${question}\u0000${hash(p.text)}`;
    const cached = [];
    const todo = [];
    for (const p of passages) {
      const k = keyOf(p);
      if (cache.has(k)) cached.push([p.id, cache.get(k)]);
      else todo.push(p);
    }
    if (cached.length) send({ type: "scores", scores: cached });

    // Passages arrive ordered by distance from the reader's viewport; batches keep that order.
    const batches = [];
    for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));
    const byId = new Map(todo.map((p) => [p.id, p]));

    try {
      const { tokens } = await scoreBatches({
        apiKey, title, question, batches, signal,
        onScores: (scores) => {
          for (const [id, score] of scores) {
            if (cache.size > MAX_CACHE) cache.clear();
            cache.set(keyOf(byId.get(id)), score);
          }
          send({ type: "scores", scores });
        },
      });
      send({
        type: "done",
        ms: Math.round(performance.now() - started),
        requests: batches.length,
        cost: (tokens / 1e6) * PRICE_PER_M,
      });
    } catch (err) {
      if (signal.aborted) return;
      send({ type: "error", code: err.status === 401 ? "bad-key" : "failed", message: err.message });
    }
  });
});
