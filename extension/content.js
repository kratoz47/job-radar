(() => {
  const scanId = new URL(location.href).searchParams.get('_radar_scan');
  if (!scanId) return;

  // BOSS 把薪资数字映射到私有区字符：\ue031=0 … \ue03a=9
  const decodePua = (s) => s.replace(/[\ue031-\ue03a]/g, (c) => String(c.codePointAt(0) - 0xe031));
  const text = (el) => (el ? decodePua(el.textContent).replace(/\s+/g, ' ').trim() : '');
  let sentWithCards = false;

  function collect() {
    const cards = [...document.querySelectorAll('.job-card-wrapper, .job-card-box')];
    const out = [];
    for (const c of cards) {
      const a = c.querySelector('a.job-name[href]') || c.querySelector('a[href*="/job_detail/"]');
      const title = text(c.querySelector('a.job-name')) || text(c.querySelector('.job-name'));
      if (!title) continue;
      const tags = [...c.querySelectorAll('.tag-list li')].map(text).filter(Boolean).slice(0, 8);
      out.push({
        title,
        salary: text(c.querySelector('.job-salary')),
        company: text(c.querySelector('.boss-name, .company-name')),
        area: text(c.querySelector('.company-location, .job-area')),
        info: tags.join(' · '),
        tags,
        url: a ? new URL(a.getAttribute('href'), location.origin).href : '',
      });
    }
    return out;
  }

  function send(jobs) {
    try {
      chrome.runtime.sendMessage({ type: 'ingest', scanId, url: location.href, jobs, html: document.body.innerHTML.slice(0, 50000) }, () => {});
    } catch { /* extension context lost */ }
  }

  function attempt(n) {
    if (sentWithCards) return;
    const jobs = collect();
    if (jobs.length) { sentWithCards = true; send(jobs); return; }
    send(jobs);
    if (n < 12) setTimeout(() => attempt(n + 1), 2000);
  }
  attempt(0);
})();
