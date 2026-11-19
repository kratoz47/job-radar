(() => {
  const scanId = new URL(location.href).searchParams.get('_radar_scan');
  if (!scanId) return;
  let sent = false;

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function collect() {
    const anchors = [...document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"]')];
    const out = [];
    const byId = new Map();
    for (const a of anchors) {
      const href = new URL(a.getAttribute('href'), location.origin).href;
      const id = (href.match(/(?:search_result|explore)\/([^?/]+)/) || [])[1];
      if (!id) continue;
      // 优先保留带 xsec_token 的 search_result 链接
      const prev = byId.get(id);
      if (prev && (prev.href.includes('xsec_token') || !href.includes('xsec_token'))) continue;
      byId.set(id, { href, a });
    }
    for (const [id, { href, a }] of byId) {
      const card = a.closest('section, .note-item, .note-card, li') || a.parentElement;
      if (!card) continue;
      const title = clean(
        (card.querySelector('.title, .note-title, [class*="title"]') || {}).textContent ||
        a.getAttribute('title') || a.querySelector('img')?.alt || ''
      );
      const author = clean((card.querySelector('.author, .author-wrapper, [class*="author"] .name, [class*="name"]') || {}).textContent || '');
      const likes = clean((card.querySelector('.like-wrapper .count, [class*="like"] [class*="count"]') || {}).textContent || '');
      const img = card.querySelector('img');
      const cover = img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '';
      const noteUrl = href.replace('/search_result/', '/explore/').replace(/xsec_source=[^&]*/, 'xsec_source=pc_search');
      out.push({ title, author, likes, cover, url: noteUrl, noteId: id });
    }
    return out.filter(x => x.title);
  }

  function send(jobs) {
    try { chrome.runtime.sendMessage({ type: 'ingest', scanId, url: location.href, jobs, html: document.body.innerHTML.slice(0, 50000) }, () => {}); } catch { /* ignore */ }
  }

  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    const jobs = collect();
    if (jobs.length) { sent = true; send(jobs); clearInterval(timer); return; }
    if (n === 6) send([]);
    if (n > 12) { clearInterval(timer); if (!sent) send([]); }
  }, 1500);
})();
