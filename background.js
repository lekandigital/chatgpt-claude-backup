// background.js — the extension's one service worker. Each half keeps its own message
// listener: Claude messages carry `action`, ChatGPT messages carry `type`.
importScripts("claude/background.js", "chatgpt/service-worker.js");

// ── Automation (see automation.js) ──────────────────────────────────

const ARCHIVE_PAGES = { claude: "claude/archive.html", chatgpt: "chatgpt/archive/archive.html" };
const ARCHIVE_PARAMS = {
  claude: ["root", "uuids", "extra", "force", "probe", "project"],
  chatgpt: ["root", "ids", "extra", "force", "probe", "account", "libraryPages", "redo", "project"],
};

async function readAutomationTokenFile() {
  try {
    const response = await fetch(chrome.runtime.getURL("automation-token.txt"));
    return response.ok ? (await response.text()).trim() : "";
  } catch {
    return "";
  }
}

function senderSite(sender) {
  try {
    const host = new URL(sender.url).hostname;
    return host === "chatgpt.com" ? "chatgpt" : host === "claude.ai" ? "claude" : null;
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request?.action !== "automationCommand") return false;
  (async () => {
    const token = await readAutomationTokenFile();
    const params = request.params || {};
    if (token.length < 16 || params.token !== token) {
      console.warn("[ChatGPT + Claude Backup] Ignored automation command with a bad token");
      return;
    }
    if (sender.tab?.id !== undefined) await chrome.tabs.remove(sender.tab.id).catch(() => {});
    if (params.cmd === "reload") {
      chrome.runtime.reload();
      return;
    }
    if (params.cmd === "archive") {
      // site= picks the archiver; otherwise the site the link was opened on.
      const site = ARCHIVE_PAGES[params.site] ? params.site : senderSite(sender);
      if (!site) return;
      const query = new URLSearchParams({ auto: "1" });
      for (const key of ARCHIVE_PARAMS[site]) if (typeof params[key] === "string" && params[key]) query.set(key, params[key]);
      // The ChatGPT archiver calls its chat list `ids`; accept Claude's `uuids` too.
      if (site === "chatgpt" && params.uuids && !params.ids) query.set("ids", params.uuids);
      if (site === "claude" && params.ids && !params.uuids) query.set("uuids", params.ids);
      await chrome.tabs.create({ url: chrome.runtime.getURL(`${ARCHIVE_PAGES[site]}?${query}`), active: false });
    }
  })();
  return false;
});
