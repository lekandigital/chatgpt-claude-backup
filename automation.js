// automation.js — lets a local script drive the extension by opening a link such as
//   https://claude.ai/#ccb=<token>&cmd=archive&site=claude&uuids=a,b&root=…
//   https://chatgpt.com/#ccb=<token>&cmd=archive&ids=a,b&root=…
//   https://claude.ai/#ccb=<token>&cmd=reload
// The older prefixes still work: #ceh= (Claude Export Hub) and #cga= (ChatGPT downloader).
// The token must match automation-token.txt in the extension folder (checked in background.js),
// so web pages cannot trigger anything.
(() => {
  const match = /^#(ccb|ceh|cga)=/.exec(location.hash);
  if (!match) return;
  const params = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  // Keep the prefix key too: a worker from before the reload may still check it.
  params.token = params[match[1]];
  history.replaceState(null, "", location.pathname + location.search);
  chrome.runtime.sendMessage({ action: "automationCommand", params }).catch(() => {});
})();
