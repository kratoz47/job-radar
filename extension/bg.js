const API = 'http://127.0.0.1:7788';
fetch(`${API}/api/extension/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: 'bg', msg: 'bg-boot' }) }).catch(() => {});

async function relay(payload) {
  fetch(`${API}/api/extension/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: 'bg', msg: 'relay ' + (payload.jobs || []).length }) }).catch(() => {});
  try {
    await fetch(`${API}/api/extension/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch { /* 本地服务没起 */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'ingest') {
    relay({ scanId: msg.scanId, url: msg.url, jobs: msg.jobs || [], html: msg.html || '' });
    sendResponse({ ok: true });
  }
  return true;
});

// 多页扫描：第 2..N 页由 background 另开标签
(async () => {
  try {
    const r = await fetch(`${API}/api/extension/config`, { cache: 'no-store' });
    const cfg = await r.json();
    const urls = cfg && cfg.urls ? cfg.urls.slice(1) : [];
    for (const url of urls) {
      const tab = await chrome.tabs.create({ url });
      const inject = () => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
      setTimeout(inject, 2500);
      setTimeout(inject, 7000);
    }
  } catch { /* ignore */ }
})();
