// popup.js — starts backups. The work itself runs in the Claude or ChatGPT backup page
// (claude/archive.html, chatgpt/archive/archive.html), which keeps going after this popup
// closes and mirrors its progress into chrome.storage for the "Last backup" box.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SITES = {
  claude: {
    name: "Claude",
    host: "claude.ai",
    page: "claude/archive.html",
    idsParam: "uuids",
    defaultRoot: "Claude Full Archive",
    chatId: (url) => url.pathname.match(new RegExp(`^/chat/(${UUID})`, "i"))?.[1] || null,
    projectId: (url) => url.pathname.match(new RegExp(`^/project/(${UUID})`, "i"))?.[1] || null,
    cleanTitle: (title) => title.replace(/\s+[-–]\s+Claude$/, "").trim(),
    more: { label: "ZIP export (older modes)", page: "../claude/zip-export.html" },
    allWarning:
      "Saves every chat, then your projects and account files, into the folder. Chats already saved there and unchanged are skipped. Keep the tab that opens until it says Done.",
  },
  chatgpt: {
    name: "ChatGPT",
    host: "chatgpt.com",
    page: "chatgpt/archive/archive.html",
    idsParam: "ids",
    defaultRoot: "ChatGPT Full Archive",
    chatId: (url) => url.pathname.match(new RegExp(`/c/(${UUID})`, "i"))?.[1] || null,
    projectId: (url) => url.pathname.match(/^\/g\/(g-p-[0-9a-f]{32})/i)?.[1] || null,
    cleanTitle: (title) => title.replace(/^ChatGPT\s+[-–]\s+/, "").trim(),
    more: { label: "Attachments & transcript", page: "../chatgpt/popup/popup.html" },
    allWarning:
      "ChatGPT allows about one chat read a minute after the first ~200, so a large account takes many hours and your own ChatGPT use may be rate-limited meanwhile. Chats already saved in the folder and unchanged are skipped. Keep the tab that opens.",
  },
};
const TERMINAL = new Set(["done", "stopped", "error"]);
const $ = (id) => document.getElementById(id);

let site = "claude";
let tab = null; // the browser tab the popup was opened on
let page = { chatId: null, projectId: null, title: "" };
let confirmingAll = false;
let running = false;

async function storageGet(keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch {
    return {};
  }
}

function readPage() {
  page = { chatId: null, projectId: null, title: "" };
  if (!tab?.url) return;
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }
  if (url.hostname !== SITES[site].host) return;
  page.chatId = SITES[site].chatId(url);
  page.projectId = SITES[site].projectId(url);
  page.title = SITES[site].cleanTitle(tab.title || "");
}

function renderContext() {
  const cfg = SITES[site];
  readPage();
  const onSite = (() => {
    try {
      return new URL(tab?.url || "").hostname === cfg.host;
    } catch {
      return false;
    }
  })();
  if (page.chatId) {
    $("context-title").textContent = page.title || `${cfg.name} chat`;
    $("context-note").textContent = page.projectId ? "Chat in a project — its project is saved too." : `Chat ${page.chatId.slice(0, 8)}`;
  } else if (page.projectId) {
    $("context-title").textContent = page.title || `${cfg.name} project`;
    $("context-note").textContent = "Project page — back up all of its chats and files.";
  } else if (onSite) {
    $("context-title").textContent = cfg.name;
    $("context-note").textContent = "Open a chat to back it up on its own.";
  } else {
    $("context-title").textContent = `Not on ${cfg.host}`;
    $("context-note").textContent = `Choose chats or back up everything; open a chat on ${cfg.host} to back up just that one.`;
  }
}

function render() {
  const cfg = SITES[site];
  document.body.dataset.site = site;
  for (const button of document.querySelectorAll(".tabs button")) {
    button.setAttribute("aria-selected", String(button.dataset.site === site));
  }
  renderContext();
  $("this-chat").disabled = running || !page.chatId;
  $("this-project").hidden = !page.projectId;
  $("this-project").disabled = running;
  $("choose").disabled = running;
  $("all").disabled = running;
  $("all").classList.toggle("confirm", confirmingAll);
  $("all").textContent = confirmingAll ? `Start: back up every ${cfg.name} chat` : "Back up all chats";
  $("all-warning").hidden = !confirmingAll;
  $("all-warning").textContent = cfg.allWarning;
  $("more-tool").textContent = cfg.more.label;
}

async function loadRoot() {
  const key = `popup:root:${site}`;
  const stored = await storageGet(key);
  $("root").value = stored[key] || SITES[site].defaultRoot;
}

function saveRoot() {
  const value = $("root").value.trim() || SITES[site].defaultRoot;
  chrome.storage.local.set({ [`popup:root:${site}`]: value }).catch(() => {});
  return value;
}

async function renderStatus() {
  const key = `backup-status:${site}`;
  const s = (await storageGet(key))[key];
  running = false;
  if (!s) {
    $("status").hidden = true;
    render();
    return;
  }
  // A run is live while its backup page is still open and has not finished.
  let pageOpen = false;
  if (Number.isInteger(s.tabId)) {
    pageOpen = await chrome.tabs.get(s.tabId).then(
      (t) => Boolean(t?.url?.startsWith(chrome.runtime.getURL(SITES[site].page))),
      () => false,
    );
  }
  running = pageOpen && !TERMINAL.has(s.phase);
  const age = Math.max(0, Math.round((Date.now() - Date.parse(s.updated_at || s.started_at)) / 1000));
  const ago = age < 90 ? `${age}s ago` : age < 5400 ? `${Math.round(age / 60)} min ago` : new Date(s.updated_at).toLocaleString();
  const what = { all: "all chats", selected: "chosen chats", project: "a project" }[s.mode] || s.mode || "backup";
  $("status").hidden = false;
  $("status-fill").style.width = `${s.total ? Math.round((100 * s.processed) / s.total) : TERMINAL.has(s.phase) ? 100 : 0}%`;
  $("status-line").textContent =
    `${running ? "Running" : s.phase} · ${what} → ${s.root} · ${s.processed}/${s.total || "?"} chats · ` +
    `${s.archived} saved, ${s.skipped} unchanged, ${s.failed} failed · ${ago}`;
  $("status-log").textContent = s.current && running ? `Now: ${s.current}` : s.last_log || "";
  $("show-run").hidden = !pageOpen;
  $("show-run").onclick = async () => {
    const t = await chrome.tabs.update(s.tabId, { active: true });
    if (t?.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
    window.close();
  };
  render();
}

function openBackupPage(query, active) {
  const params = new URLSearchParams({ root: saveRoot(), ...query });
  return chrome.tabs.create({ url: chrome.runtime.getURL(`${SITES[site].page}?${params}`), active });
}

function force() {
  return $("force").checked ? { force: "1" } : {};
}

async function selectSite(next) {
  site = next;
  confirmingAll = false;
  chrome.storage.local.set({ "popup:site": site }).catch(() => {});
  await loadRoot();
  await renderStatus();
}

$("tab-claude").addEventListener("click", () => selectSite("claude"));
$("tab-chatgpt").addEventListener("click", () => selectSite("chatgpt"));
$("root").addEventListener("change", saveRoot);

// One chat: always a fresh copy; it runs in a background tab and reports here.
$("this-chat").addEventListener("click", async () => {
  if (!page.chatId) return;
  await openBackupPage({ auto: "1", [SITES[site].idsParam]: page.chatId, force: "1" }, false);
  $("status-line").textContent = "Starting…";
  $("status").hidden = false;
});
$("this-project").addEventListener("click", async () => {
  if (!page.projectId) return;
  await openBackupPage({ auto: "1", project: page.projectId, ...force() }, false);
  $("status-line").textContent = "Starting…";
  $("status").hidden = false;
});
$("choose").addEventListener("click", async () => {
  await openBackupPage({ pick: "1", ...force() }, true);
  window.close();
});
$("all").addEventListener("click", async () => {
  if (!confirmingAll) {
    confirmingAll = true;
    render();
    return;
  }
  await openBackupPage({ auto: "1", ...force() }, true);
  window.close();
});
$("open-page").addEventListener("click", async () => {
  await openBackupPage({}, true);
  window.close();
});
$("more-tool").addEventListener("click", () => {
  location.href = SITES[site].more.page;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[`backup-status:${site}`]) renderStatus();
});

(async () => {
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const requested = new URLSearchParams(location.search).get("site");
  let initial = SITES[requested] ? requested : null;
  if (!initial) {
    try {
      const host = new URL(tab?.url || "").hostname;
      initial = Object.keys(SITES).find((key) => SITES[key].host === host) || null;
    } catch {
      // not a web page
    }
  }
  if (!initial) initial = (await storageGet("popup:site"))["popup:site"] || "claude";
  await selectSite(SITES[initial] ? initial : "claude");
})();
