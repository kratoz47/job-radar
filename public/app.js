const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const STATUS = {
  todo: '待投递', applied: '已投递', interview: '面试中', offer: 'Offer', rejected: '已拒',
};
const SOURCE_NAME = { jobui: '职友集', eleduck: '电鸭', yuancheng: '远程.work', remoteok: 'RemoteOK', remotive: 'Remotive', zhipin: 'BOSS直聘', jobicy: 'Jobicy', workingnomads: 'Working Nomads', chinahr: '中华英才', xhs: '小红书' };
const VIEWS = {
  overview: ['概览', '按关键词扫描多平台岗位'],
  recommend: ['投递建议', '先投匹配高的，再算远程叠加的时间账'],
  local: ['昆明 · 云南', '本地岗位，可到岗；标注远程的已归入远程区'],
  remote: ['全国远程', '中国境内可远程的岗位'],
  overseas: ['海外远程', '英文远程岗，注意时区与地区限制'],
  applications: ['投递记录', '跟进每一次投递的状态'],
  settings: ['设置', '简历、搜索方向与扫描'],
  login: ['平台登录', '登录扫描与付费平台'],
  search: ['搜索结果', '跨数据源搜索'],
};

const state = {
  view: 'overview',
  stats: null,
  scans: [],
  jobs: [],
  total: 0,
  offset: 0,
  limit: 60,
  loading: false,
  filters: { q: '', source: 'all', relevant: false, sort: 'date', minSalary: '' },
  scanRunning: false,
  resumes: [],
  applications: [],
  recs: null,
  recHours: 50,
  emailConfig: null,
  searchConfig: null,
  directionDirty: localStorage.getItem('radar_direction_dirty') === '1',
};

// ---------------- utils ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n == null ? '–' : Intl.NumberFormat('zh-CN').format(n));
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 86400000;
  if (diff < 1) return '今天';
  if (diff < 2) return '昨天';
  if (diff < 30) return `${Math.floor(diff)} 天前`;
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
};
const logoColor = (name = '') => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h}, 34%, 40%)`;
};
const logoText = (name = '') => (name || '?').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 2) || '?';

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

function debounce(fn, ms = 320) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------- routing ----------------
function currentRoute() {
  const h = location.hash.replace(/^#\//, '') || 'overview';
  return VIEWS[h] ? h : 'overview';
}

function setActiveNav(view) {
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
}


// ---------------- 搜索方向（全局主控） ----------------
const dirKey = (c) => JSON.stringify([...(c?.keywords || []), c?.city || '', !!c?.overseas]);
const dirChanged = () => {
  const last = state.searchConfig?.lastScanConfig;
  if (!last) return false;
  return dirKey(state.searchConfig) !== dirKey(last);
};
let dirDraft = null;

function directionSummaryHTML() {
  const cfg = state.searchConfig || { keywords: [], city: '昆明', overseas: true };
  const chips = (cfg.keywords || []).map(k => `<span class="scope-chip">${esc(k)}</span>`).join('') || '<span class="scope-meta">未设置关键词</span>';
  return `${chips}<span class="scope-meta">${esc(cfg.city || '昆明')}${cfg.overseas !== false ? ' · 含海外' : ' · 不含海外'}</span>`;
}

function renderScopeBar() {
  const bar = $('#scopeBar');
  if (!bar) return;
  if (['login', 'settings', 'applications'].includes(state.view)) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const changed = dirChanged() || state.directionDirty;
  const hasScan = !!state.searchConfig?.lastScanConfig || !!state.stats?.lastScan;
  bar.innerHTML = `
    <div class="scope-left">
      <span class="scope-label">当前搜索方向</span>
      ${directionSummaryHTML()}
      ${changed ? '<span class="scope-warn">方向已改 · 尚未重扫</span>' : ''}
      ${!hasScan ? '<span class="scope-warn">尚未扫描</span>' : ''}
    </div>
    <div class="scope-actions">
      <button class="scope-change" id="scopeChange">调整方向</button>
      <button class="scope-change" id="scopeRescan">重扫</button>
    </div>`;
  $('#scopeChange').onclick = openDirection;
  $('#scopeRescan').onclick = openDirection;
}

function renderDirChips() {
  const box = $('#dirChips');
  if (!box || !dirDraft) return;
  box.innerHTML = dirDraft.keywords.map((k, i) => `<span class="dir-chip">${esc(k)}<button data-dir-del="${i}" aria-label="移除">×</button></span>`).join('')
    || '<span class="hint">还没有关键词</span>';
  $('#dirCount').textContent = `${dirDraft.keywords.length} / 10`;
  box.querySelectorAll('[data-dir-del]').forEach(b => {
    b.onclick = () => { dirDraft.keywords.splice(Number(b.dataset.dirDel), 1); renderDirChips(); };
  });
}

function updateDirImpact() {
  const n = dirDraft?.keywords.length || 0;
  $('#dirImpact').innerHTML = n
    ? `下一轮将扫描：职友集（${Math.min(2, n)} 组关键词 × 城市/全国）· 中华英才 · 电鸭 3 页 · 远程.work 3 页${dirDraft.overseas ? ' · 4 个海外站' : ''}。<br/>预计 40–90 秒。换词会新增/更新岗位，旧岗位保留。`
    : '至少添加一个关键词才能保存。';
  const disabled = !n;
  $('#dirSave').disabled = disabled;
  $('#dirRescan').disabled = disabled || !$('#dirConfirm').checked;
}

function openDirection() {
  if (state.scanRunning) { toast('扫描进行中，结束后再调整方向', true); return; }
  const cfg = state.searchConfig || { keywords: [], city: '昆明', overseas: true };
  dirDraft = { keywords: [...(cfg.keywords || [])], city: cfg.city || '昆明', overseas: cfg.overseas !== false };
  $('#dirCurrent').innerHTML = `当前保存：${directionSummaryHTML()}`;
  $('#dirCity').value = dirDraft.city;
  $('#dirOverseas').checked = dirDraft.overseas;
  $('#dirInput').value = '';
  $('#dirConfirm').checked = false;
  renderDirChips();
  updateDirImpact();
  $('#directionModal').classList.add('open');
  $('#directionModal').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#dirInput')?.focus(), 60);
}

function closeDirection() {
  $('#directionModal').classList.remove('open');
  $('#directionModal').setAttribute('aria-hidden', 'true');
}

async function saveDirection({ rescan = false } = {}) {
  if (!dirDraft?.keywords.length) { toast('至少保留一个关键词', true); return; }
  const before = state.searchConfig;
  const saved = await api('/api/search-config', {
    method: 'POST',
    body: { keywords: dirDraft.keywords.join(','), city: dirDraft.city.trim() || '昆明', overseas: dirDraft.overseas },
  });
  if (before?.keywords) localStorage.setItem('radar_prev_direction', JSON.stringify({ keywords: before.keywords, city: before.city, overseas: before.overseas }));
  state.searchConfig = { ...saved, lastScanConfig: before?.lastScanConfig || null };
  state.directionDirty = true;
  localStorage.setItem('radar_direction_dirty', '1');
  closeDirection();
  renderScopeBar();
  if (rescan) {
    toast('方向已保存，开始重扫');
    await startScan();
  } else {
    toast('方向已保存；现有列表不变，下次扫描生效');
  }
}

function bindDirectionModal() {
  $('#dirClose').onclick = closeDirection;
  $('#dirCancel').onclick = closeDirection;
  $('#directionModal').addEventListener('click', (e) => { if (e.target.id === 'directionModal') closeDirection(); });
  $('#dirAdd').onclick = () => {
    const raw = $('#dirInput').value.trim();
    if (!raw || !dirDraft) return;
    for (const part of raw.split(/[,，、]+/).map(x => x.trim()).filter(Boolean)) {
      if (dirDraft.keywords.length >= 10) { toast('最多 10 个关键词', true); break; }
      if (!dirDraft.keywords.includes(part)) dirDraft.keywords.push(part);
    }
    $('#dirInput').value = '';
    renderDirChips();
    updateDirImpact();
    $('#dirInput').focus();
  };
  $('#dirInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dirAdd').click(); } });
  $('#dirConfirm').addEventListener('change', updateDirImpact);
  $('#dirCity').addEventListener('input', () => { if (dirDraft) dirDraft.city = $('#dirCity').value; });
  $('#dirOverseas').addEventListener('change', () => { if (dirDraft) dirDraft.overseas = $('#dirOverseas').checked; updateDirImpact(); });
  $('#dirSave').onclick = async () => {
    try { await saveDirection({ rescan: false }); }
    catch (e) { toast('保存失败：' + e.message, true); }
  };
  $('#dirRescan').onclick = async () => {
    if (!$('#dirConfirm').checked) return;
    try { await saveDirection({ rescan: true }); }
    catch (e) { toast('保存失败：' + e.message, true); }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#directionModal').classList.contains('open')) closeDirection();
  });
  $('#dirRestore').onclick = () => {
    try {
      const prev = JSON.parse(localStorage.getItem('radar_prev_direction') || 'null');
      if (!prev?.keywords?.length || !dirDraft) { toast('没有可恢复的上一次方向', true); return; }
      dirDraft = { keywords: [...prev.keywords], city: prev.city || '昆明', overseas: prev.overseas !== false };
      $('#dirCity').value = dirDraft.city;
      $('#dirOverseas').checked = dirDraft.overseas;
      renderDirChips();
      updateDirImpact();
      toast('已填入上一次方向，确认后再保存');
    } catch { toast('恢复失败', true); }
  };
}

async function route() {
  closeDrawer();
  state.view = currentRoute();
  setActiveNav(state.view);
  const [title, sub] = VIEWS[state.view];
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  $('#globalSearch').value = state.filters.q;
  if (state.view === 'applications') await loadApplications();
  if (state.view === 'settings') await loadSettings();
  await render();
  renderScopeBar();
}

// ---------------- data ----------------
async function loadStats() {
  state.stats = await api('/api/stats');
  renderCounts();
}

function renderCounts() {
  const s = state.stats;
  if (!s) return;
  $('#c-all').textContent = fmtNum(s.total);
  $('#c-local').textContent = fmtNum(s.byChannel.local || 0);
  $('#c-remote').textContent = fmtNum(s.byChannel.remote || 0);
  $('#c-overseas').textContent = fmtNum(s.byChannel.overseas || 0);
  const applied = (s.applied || []).filter(a => a.status !== 'todo').reduce((n, a) => n + a.c, 0);
  $('#c-apps').textContent = applied ? fmtNum(applied) : '';
}

async function loadJobs(reset = true) {
  if (state.loading) return;
  state.loading = true;
  if (reset) { state.offset = 0; state.jobs = []; }
  try {
  const channel = state.view === 'search' || state.view === 'overview' ? 'all' : state.view;
  const p = new URLSearchParams({
    channel, q: state.filters.q, source: state.filters.source,
    sort: state.filters.sort, limit: state.limit, offset: state.offset,
  });
  if (state.filters.relevant) p.set('relevant', '1');
  if (state.filters.minSalary) p.set('minSalary', state.filters.minSalary);
    const data = await api(`/api/jobs?${p}`);
    state.jobs = reset ? data.rows : state.jobs.concat(data.rows);
    state.total = data.total;
    state.offset += data.rows.length;
  } finally {
    state.loading = false;
  }
}

async function loadApplications() {
  state.applications = await api('/api/applications');
}

async function loadSettings() {
  state.resumes = await api('/api/resumes');
  state.profile = await api('/api/profile').catch(() => null);
  state.emailConfig = await api('/api/email/config').catch(() => null);
  state.searchConfig = await api('/api/search-config').catch(() => null);
}

// ---------------- render ----------------
async function render() {
  const view = $('#view');
  view.innerHTML = `<div class="skeleton" style="height:120px;margin-bottom:14px"></div><div class="skeleton" style="height:300px"></div>`;
  try {
    if (state.view === 'overview') await renderOverview();
    else if (state.view === 'recommend') await renderRecommend();
    else if (['local', 'remote', 'overseas', 'search'].includes(state.view)) await renderJobs();
    else if (state.view === 'applications') renderApplications();
    else if (state.view === 'settings') renderSettings();
    else if (state.view === 'login') await renderLogin();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty"><div class="big">⚠</div><h3>页面加载失败</h3><p>${esc(e.message)}<br/>检查本地服务是否在运行，然后刷新。</p></div>`;
  }
}

function statCard(label, value, unit, foot) {
  return `<div class="stat-card">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</div>
    <div class="stat-foot">${esc(foot)}</div>
  </div>`;
}

async function renderOverview() {
  const s = state.stats || await api('/api/stats');
  state.stats = s;
  const [scansData, platforms] = await Promise.all([api('/api/scans'), api('/api/platforms')]);
  state.scans = scansData;
  state.platforms = platforms;
  renderCounts();
  const remote = (s.byChannel.remote || 0) + (s.byChannel.overseas || 0);
  const appliedN = (s.applied || []).filter(a => a.status !== 'todo').reduce((n, a) => n + a.c, 0);
  const total = s.total || 0;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);

  const funnel = ['todo', 'applied', 'interview', 'offer', 'rejected'].map(k => {
    const c = (s.applied || []).find(a => a.status === k)?.c || 0;
    return `<div class="bar-row"><span>${STATUS[k]}</span><div class="bar-track"><div class="bar-fill ${k === 'offer' ? 'green' : k === 'rejected' ? '' : 'blue'}" style="width:${appliedN ? Math.max(3, (c / appliedN) * 100) : 0}%"></div></div><span class="bar-num">${c}</span></div>`;
  }).join('');

  const sourceRows = (s.sources || []).map(x => `
    <div class="bar-row"><span>${SOURCE_NAME[x.source] || x.source}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct(x.c)}%"></div></div>
      <span class="bar-num">${x.c}</span></div>`).join('') || '<div class="empty" style="padding:20px">暂无</div>';

  const companies = (s.companies || []).map(c => `
    <div class="company-row">
      <span class="mini-logo" style="background:${logoColor(c.company)}">${esc(logoText(c.company))}</span>
      <span>${esc(c.company)}</span><span class="cnt">${c.c} 个岗位</span>
    </div>`).join('') || '<div class="empty" style="padding:20px">暂无</div>';

  const scans = (state.scans || []).slice(0, 6).map(sc => `
    <div class="scan-item">
      <span class="${sc.status === 'ok' ? 'ok' : 'err'}">${sc.status === 'ok' ? '✓' : '✕'}</span>
      <span>${sc.status === 'ok' ? '扫描完成' : '扫描失败'}${sc.stats?.added != null ? ` · 新增 ${sc.stats.added}` : ''}${sc.stats?.ms ? ` · ${(sc.stats.ms / 1000).toFixed(0)}s` : ''}</span>
      <time>${fmtDate(sc.finished_at || sc.started_at)}</time>
    </div>`).join('') || '<div class="empty" style="padding:20px">还没有扫描记录</div>';

  const warn = (s.byChannel.local || 0) < 5
    ? `<div class="note-box" style="margin-bottom:16px">昆明本地匹配到的岗位较少（${s.byChannel.local || 0} 个）。可以在「设置 → 搜索关键词」换词，或把城市改成其他城市。</div>`
    : '';

  $('#view').innerHTML = `
    ${warn}
    <div class="grid-stats">
      ${statCard('岗位总数', fmtNum(total), '', `平均简历匹配 ${s.avgMatch ?? 0} · 全库去重`)}
      ${statCard('24h 新增', fmtNum(s.fresh), '', '首次出现的岗位')}
      ${statCard('远程岗位', fmtNum(remote), '', `国内 ${s.byChannel.remote || 0} · 海外 ${s.byChannel.overseas || 0}`)}
      ${statCard('已投递', fmtNum(appliedN), '', (s.applied || []).length ? '含面试中 / Offer' : '点岗位卡片开始投递')}
    </div>
    <div class="panels">
      <div>
        <div class="panel">
          <div class="panel-head"><h3>岗位分布</h3><span>按投递通道</span></div>
          ${[['昆明 · 云南', s.byChannel.local || 0, ''], ['全国远程', s.byChannel.remote || 0, 'green'], ['海外远程', s.byChannel.overseas || 0, 'blue']].map(([n, c, cls]) => `
            <div class="bar-row"><span>${n}</span><div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct(c)}%"></div></div><span class="bar-num">${c}</span></div>`).join('')}
          <div class="panel-head" style="margin-top:20px"><h3>来源</h3><span>抓取渠道</span></div>
          ${sourceRows}
        </div>
        <div class="panel">
          <div class="panel-head"><h3>投递漏斗</h3><span>点击「投递记录」管理</span></div>
          ${funnel}
        </div>
      </div>
      <div>
        <div class="panel">
          <div class="panel-head"><h3>最近扫描</h3><span>${state.scanRunning ? '进行中…' : '自动 6 小时一次'}</span></div>
          <div class="scan-list">${scans}</div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>招聘公司 Top</h3><span>按在招岗位数</span></div>
          ${companies}
        </div>
        <div class="panel">
          <div class="panel-head"><h3>下一步</h3><span>建议动作</span></div>
          <div class="company-row"><span class="mini-logo" style="background:#2F7D5D">1</span><span>打开「投递建议」，先投「现在就能投」的 3 个</span></div>
          <div class="company-row"><span class="mini-logo" style="background:#B08D57">2</span><span>检查简历是否为最新版（设置 → 简历）</span></div>
          <div class="company-row"><span class="mini-logo" style="background:#2C628F">3</span><span>每天回来点一次扫描，看 24h 新增</span></div>
        </div>
      </div>
    </div>
    ${platformPanelHTML(state.platforms)}`;
  const enrichBtn = $('#enrichBtn');
  if (enrichBtn) enrichBtn.onclick = async () => {
    enrichBtn.disabled = true;
    const oldText = enrichBtn.textContent;
    enrichBtn.textContent = '补链接中（最多 6 条）…';
    try {
      const r = await api('/api/enrich', { method: 'POST' });
      toast(`补到 ${r.filled} 条原站链接${r.remaining ? `，还剩 ${r.remaining} 条` : '，已补齐'}`);
    } catch (e) {
      toast('补链接失败', true);
    } finally {
      enrichBtn.disabled = false;
      enrichBtn.textContent = oldText;
      await renderOverview();
    }
  };
}

function platformPanelHTML(p) {
  if (!p) return '';
  const meta = {
    jobui: { login: '看原站', note: '聚合搜索；已回填 Boss / 智联 / 国家平台链接' },
    chinahr: { login: '否', note: '免登录公开 API；只收云南结果' },
    xhs: { login: '需登录', note: '招聘笔记；只收带招聘字样且昆明/远程的帖子' },
    eleduck: { login: '否', note: '帖子即原站，含联系方式/申请方式' },
    yuancheng: { login: '否', note: '详情页即原站，含应聘方式' },
    remoteok: { login: '部分', note: 'apply_url 直链，部分跳公司 ATS' },
    remotive: { login: '部分', note: '跳转公司申请页' },
    jobicy: { login: '部分', note: '公开 API，需署名 Jobicy' },
    workingnomads: { login: '部分', note: '公开 API，跳原站申请' },
    zhipin: { login: '需登录', note: '登录态扫描' },
  };
  const rows = p.sources.map(x => {
    const m = meta[x.source] || { login: '—', note: '' };
    const link = x.direct ? `${x.direct}/${x.total} 原站直链`
      : x.postOnly ? `${x.postOnly}/${x.total} 站内详情`
      : `${x.total - x.missing}/${x.total} 有链接`;
    return `<tr>
      <td><b>${SOURCE_NAME[x.source] || x.source}</b></td>
      <td>${x.total}</td>
      <td>${link}</td>
      <td>${m.login}</td>
      <td class="cell-sub">${m.note}</td>
    </tr>`;
  }).join('');
  const hosts = Object.entries(p.hosts || {}).sort((a, b) => b[1] - a[1])
    .map(([h, c]) => `<span class="host-chip">${esc(h)} ×${c}</span>`).join('') || '<span class="hint">暂无原站域名</span>';
  return `<div class="panel" style="margin-top:16px">
    <div class="panel-head"><h3>平台与链接</h3><span>岗位从哪来、点开要不要登录</span></div>
    <table class="platform-table">
      <thead><tr><th>平台</th><th>岗位</th><th>链接状态</th><th>点开要登录</th><th>说明</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="host-line"><span>原站域名：</span>${hosts}</div>
    <div class="enrich-row">
      <button class="btn btn-ghost btn-sm" id="enrichBtn" ${p.missing ? '' : 'disabled'}>
        ${p.missing ? `补原站链接（缺 ${p.missing} 条）` : '原站链接已补齐'}
      </button>
      <span class="hint">缺链接的是职友集聚合岗：补链接会逐条打开职友集详情页取原站地址，<b>不需要登录</b>；真正投递时才去原站登录。每轮最多补 12 条，扫描也会继续回填。</span>
      <a class="btn btn-primary btn-sm" href="#/login">平台登录 / 扫描</a>
    </div>
  </div>`;
}

function jobCard(j) {
  const showSalary = j.salary_min != null ? (j.salary_raw || formatSalary(j)) : (j.salary_raw || '面议');
  const applied = j.apply?.status;
  const ms = j.match_score ?? 0;
  const matchCls = ms >= 70 ? 'high' : ms >= 45 ? 'mid' : '';
  const remoteBadge = j.channel === 'overseas'
    ? `<span class="badge-remote overseas">海外远程</span>`
    : j.remote ? `<span class="badge-remote">远程</span>` : '';
  return `<article class="job-card" data-id="${esc(j.id)}">
    <div class="job-top">
      <span class="mini-logo" style="background:${logoColor(j.company || j.title)}">${esc(logoText(j.company || j.title))}</span>
      <div class="job-company">
        <span class="name" title="${esc(j.company || '')}">${esc(j.company || '未署名公司')}</span>
        <span class="src ${esc(j.source)}">${SOURCE_NAME[j.source] || j.source}</span>
      </div>
      <span class="job-date">${fmtDate(j.posted_at)}</span>
    </div>
    <h3 class="job-title">${esc(j.title)}</h3>
    <div class="job-meta">
      <span class="salary ${j.salary_min == null ? 'muted' : ''}">${esc(showSalary)}</span>
      <span class="loc">📍 ${esc(j.location || '—')}</span>
      ${remoteBadge}
    </div>
    ${j.tags?.length ? `<div class="tags">${j.tags.slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="job-foot">
      <span class="match ${matchCls}" title="简历与 JD 的加权匹配分"><span class="match-dot"></span>简历 ${ms}</span>
      <span class="rel" title="标题/描述与搜索关键词的相关度">相关 ${j.relevance ?? 0}</span>
      ${applied ? `<span class="applied-pill st-${applied}">${STATUS[applied]}</span>` : ''}
      <button class="btn btn-brass btn-sm" data-apply="${esc(j.id)}">投递</button>
    </div>
  </article>`;
}

function formatSalary(j) {
  const cur = j.salary_currency === 'USD' ? '$' : j.salary_currency === 'EUR' ? '€' : '¥';
  const per = { month: '/月', year: '/年', day: '/天', hour: '/时' }[j.salary_period] || '';
  const n = (v) => (v >= 10000 ? `${(v / 10000).toFixed(v % 10000 === 0 ? 0 : 1)}万` : v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v));
  return `${cur}${n(j.salary_min)}${j.salary_max ? '-' + n(j.salary_max) : ''}${per}`;
}

async function renderJobs(reload = true) {
  if (reload) await loadJobs(true);
  renderCounts();
  const sources = ['all', 'jobui', 'chinahr', 'xhs', 'eleduck', 'yuancheng', 'zhipin', 'remoteok', 'remotive', 'jobicy', 'workingnomads'];
  $('#view').innerHTML = `
    <div class="toolbar">
      <span class="result-count">共 <b>${state.total}</b> 个岗位</span>
      <label class="check"><input type="checkbox" id="fRelevant" ${state.filters.relevant ? 'checked' : ''}/> 只看相关（≥30）</label>
      <select id="fSource">${sources.map(s => `<option value="${s}" ${state.filters.source === s ? 'selected' : ''}>${s === 'all' ? '全部来源' : SOURCE_NAME[s]}</option>`).join('')}</select>
      <select id="fSalary">
        <option value="">薪资不限</option>
        ${[5000, 10000, 15000, 20000, 30000].map(v => `<option value="${v}" ${+state.filters.minSalary === v ? 'selected' : ''}>≥ ${v / 1000}k</option>`).join('')}
      </select>
      <select id="fSort">
        <option value="date" ${state.filters.sort === 'date' ? 'selected' : ''}>按发布时间</option>
        <option value="match" ${state.filters.sort === 'match' ? 'selected' : ''}>按简历匹配</option>
        <option value="relevance" ${state.filters.sort === 'relevance' ? 'selected' : ''}>按相关度</option>
        <option value="salary" ${state.filters.sort === 'salary' ? 'selected' : ''}>按薪资</option>
      </select>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" id="exportBtn">导出 CSV</button>
    </div>
    <div class="job-grid" id="jobGrid">
      ${state.jobs.length ? state.jobs.map(jobCard).join('') : emptyState()}
    </div>
    ${state.jobs.length < state.total ? `<div class="load-more"><button class="btn btn-ghost" id="moreBtn">加载更多（${state.jobs.length}/${state.total}）</button></div>` : ''}
    ${state.view === 'local' && state.total < 10 ? `<div class="note-box" style="margin-top:20px">
      <b>昆明本地为什么这么少？</b><br/>
      职友集昆明「AI」搜索有 100+ 条结果，但大多是 AI 动画、编剧、主播、标注类岗位，按「部署 / 落地 / 应用」口径过滤后只剩个位数。
      这不是抓漏了，而是本地供给确实薄。建议先投「全国远程」里匹配度 ≥60 的岗位，同时每周回来看一次本地新增。
    </div>` : ''}`;

  $('#fRelevant').onchange = (e) => { state.filters.relevant = e.target.checked; render(); };
  $('#fSource').onchange = (e) => { state.filters.source = e.target.value; render(); };
  $('#fSalary').onchange = (e) => { state.filters.minSalary = e.target.value; render(); };
  $('#fSort').onchange = (e) => { state.filters.sort = e.target.value; render(); };
  $('#exportBtn').onclick = () => { location.href = '/api/export?format=csv'; };
  const more = $('#moreBtn');
  if (more) more.onclick = async () => { more.disabled = true; await loadJobs(false); await renderJobs(false); };
}

function emptyState() {
  if (state.filters.q) return `<div class="empty" style="grid-column:1/-1"><div class="big">⌕</div><h3>没有匹配「${esc(state.filters.q)}」的岗位</h3><p>换个关键词，或到「设置」看看数据源状态。</p></div>`;
  return `<div class="empty" style="grid-column:1/-1"><div class="big">📡</div><h3>这个通道还没有岗位</h3><p>点左下角「立即扫描」抓一轮。职友集有频率限制，遇到验证码会冷却 3 小时，稍后再试即可。</p></div>`;
}

// ---------------- 平台登录 ----------------
const riskKey = (id) => `riskAck.${id}`;

async function renderLogin() {
  const dirKeywords = (state.searchConfig?.keywords?.length ? state.searchConfig.keywords : ['AI应用','大模型','AI落地']);
  const dirChips = dirKeywords.map(k => `<span class="scope-chip">${esc(k)}</span>`).join('');
  const dirCity = state.searchConfig?.city || '昆明';
  const data = await api('/api/browser/status');
  const cities = data.cities || [];
  const card = (p) => {
    const statusText = p.external ? '外部平台' : p.browserOpen ? '窗口打开中' : p.loggedIn ? '已登录' : '未登录';
    const cls = p.external ? 'off' : p.loggedIn ? 'ok' : p.browserOpen ? 'wait' : 'off';
    const last = p.lastScan;
    const scanDisabled = !p.scan || !p.loggedIn || p.browserOpen;
    return `<div class="login-card${p.paid ? ' paid' : ''}" data-platform="${p.id}">
      <div class="login-head">
        <span class="login-name">${esc(p.name)}</span>
        ${p.paid ? '<span class="pay-pill">付费</span>' : ''}
        <span class="status-pill ${cls}">${statusText}</span>
      </div>
      <div class="login-note">${esc(p.paid ? (p.payNote || '付费/会员限制，不付费可能无法投递') : (p.loginNote || ''))}</div>
      <div class="login-actions">
        ${p.external ? `<a class="btn btn-primary btn-sm" href="${esc(p.loginUrl)}" target="_blank" rel="noopener">打开平台官网 ↗</a>` : `
        <button class="btn btn-primary btn-sm" data-open ${p.browserOpen || localStorage.getItem(riskKey(p.id)) !== '1' ? 'disabled' : ''}>打开登录窗口</button>
        <button class="btn btn-ghost btn-sm" data-close ${p.browserOpen ? '' : 'disabled'}>关闭窗口</button>
        <button class="btn btn-ghost btn-sm" data-refresh>检测登录</button>
        ${p.scan && p.browserOpen ? '<button class="btn btn-brass btn-sm" data-close-scan>保存登录并扫描</button>' : ''}`}
      </div>
      ${p.external ? '' : `<label class="risk-check"><input type="checkbox" data-consent ${localStorage.getItem(riskKey(p.id)) === '1' ? 'checked' : ''}/> 我已知晓封号风险，用我自己的账号</label>`}
      ${p.scan ? `
      <div class="scan-scope">按全局方向：${dirChips}<a href="#/overview">调整</a></div>
      <div class="scan-form">
        <select data-city>${cities.map(c => `<option value="${c.id}" ${c.name === dirCity ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
        <select data-pages><option value="1">1 页</option><option value="2">2 页</option><option value="3">3 页</option></select>
        <button class="btn btn-brass btn-sm" data-scan ${scanDisabled || localStorage.getItem(riskKey(p.id)) !== '1' ? 'disabled' : ''}>用扩展扫描</button>
      </div>
      <div class="scan-hint">${esc(p.scanNote || '')} 使用全局关键词；每个关键词会各开一个标签页。</div>`
      : `<div class="scan-hint paid-hint">${p.paid ? '付费平台：不提供扫描适配；登录后去原站投递。' : '登录窗口已接入；该平台扫描适配中。'}</div>`}
      ${last ? `<div class="last-scan">
        <span class="${last.error ? 'err' : 'ok'}">${last.error ? '上次失败：' + esc(last.error) : `上次：${last.query} / ${last.city} · 抓到 ${last.fetched} 条 · 入库 ${last.kept}`}</span>
        <span>${new Date(last.at).toLocaleString('zh-CN')}</span>
      </div>${last.log?.length ? `<div class="scan-log">${last.log.map(l => `<div>${esc(l)}</div>`).join('')}</div>` : ''}` : ''}
    </div>`;
  };
  const scanCards = data.platforms.filter(p => p.scan).map(card).join('');
  const applyCards = data.platforms.filter(p => !p.scan).map(card).join('');

  $('#view').innerHTML = `
    <div class="risk-banner">
      <b>高风险功能：登录态扫描</b>
      <p>它会以你的账号身份请求招聘平台数据。平台用户协议通常禁止自动化访问，可能触发风控、限流或<b>封号</b>。工具只读取搜索结果，不自动投递；登录态只保存在本机 <span class="mono">data/browser/</span>，不会上传。是否使用由你决定。</p>
    </div>
    <div class="login-section-head">
      <div><h3>可登录扫描</h3><p>用你的登录态按全局关键词抓取；风险最高，频率要低。</p></div>
      <span>${data.platforms.filter(p => p.scan).length} 个平台</span>
    </div>
    <div class="login-grid">${scanCards}</div>

    <div class="login-section-head paid-head">
      <div><h3>付费平台（扫描适配中）</h3><p>类似 We Work Remotely / 猎聘 / 智联这类需要会员或付费投递包的平台。本工具只打开原站，不代付、不绕过付费墙。</p></div>
      <span>${data.platforms.filter(p => !p.scan).length} 个平台</span>
    </div>
    <div class="pay-banner">
      <b>不付费可能无法投递。</b> 这些平台通常把“投递/简历查看/刷新”放在会员或付费包里。工具不会替你购买，也不做绕过；登录窗口只是方便你进原站操作。
    </div>
    <div class="login-grid">${applyCards}</div>
    <div class="note-box" style="margin-top:16px">
      <b>使用顺序：</b>勾选风险确认 → 打开登录窗口 → 在弹出窗口里扫码/密码登录 → 关掉窗口 → 点「检测登录」确认状态 → 用登录态扫描。
      扫描会开一个带扩展的 Chrome 窗口（移到屏幕外），扩展在页面内读岗位卡片后回传，全程不连 CDP，读完即关；建议每次 1–2 页、每天不超过 2 次。
      <br/><b>登录窗口和扫描窗口都是原生 Chrome + 扩展</b>，全程不连 Playwright/CDP；扩展在页面内读岗位卡片后回传给本地服务。
      <br/><b>登录后请用「关闭窗口」按钮</b>：它会先让 Chrome 自己退出（保存 Cookie），最多等 10 秒才强杀。直接强退可能丢登录态。
      <br/><b>窗口一开就关？</b>点「关闭窗口」清理旧进程，再重新打开；仍失败就删掉 <span class="mono">data/browser/zhipin/Singleton*</span>（不影响已保存的登录态）。
      <br/><b>失败排查：</b>提示「未检测到登录态」→ 重新登录；提示「安全校验」→ 停 1 小时再试，别连续刷。
    </div>`;

  $$('.login-card').forEach(card => {
    const id = card.dataset.platform;
    const consent = card.querySelector('[data-consent]');
    const openBtn = card.querySelector('[data-open]');
    const closeBtn = card.querySelector('[data-close]');
    const scanBtn = card.querySelector('[data-scan]');
    const sync = () => {
      localStorage.setItem(riskKey(id), consent.checked ? '1' : '0');
      if (openBtn) openBtn.disabled = !consent.checked;
      if (scanBtn) {
        const p = data.platforms.find(x => x.id === id);
        scanBtn.disabled = !consent.checked || !p.loggedIn || p.browserOpen;
      }
    };
    if (consent) consent.onchange = sync;
    if (openBtn) openBtn.onclick = async () => {
      openBtn.disabled = true;
      openBtn.textContent = '正在打开…';
      try {
        await api('/api/browser/open', { method: 'POST', body: { platform: id, consent: consent.checked } });
        toast('登录窗口已打开，完成登录后请关闭窗口');
      } catch (e) { toast('打开失败：' + e.message, true); }
      await renderLogin();
    };
    if (closeBtn) closeBtn.onclick = async () => {
      await api('/api/browser/close', { method: 'POST', body: { platform: id } });
      toast('窗口已关闭，登录态已保留');
      await renderLogin();
    };
    const refreshBtn = card.querySelector('[data-refresh]');
    if (refreshBtn) refreshBtn.onclick = () => renderLogin();
    const closeScan = card.querySelector('[data-close-scan]');
    if (closeScan) closeScan.onclick = async () => {
      const city = card.querySelector('[data-city]').value;
      const query = '';
      const pages = card.querySelector('[data-pages]').value;
      closeScan.disabled = true;
      closeScan.textContent = '保存登录并扫描…';
      try {
        const r = await api('/api/browser/close-and-scan', { method: 'POST', body: { platform: id, city, query, pages } });
        toast(`扫描完成：抓到 ${r.fetched} 条，入库 ${r.kept} 条`);
        state.recs = null;
        await loadStats();
      } catch (e) {
        toast('扫描失败：' + e.message, true);
      }
      await renderLogin();
    };
    if (scanBtn) scanBtn.onclick = async () => {
      const city = card.querySelector('[data-city]').value;
      const query = '';
      const pages = card.querySelector('[data-pages]').value;
      scanBtn.disabled = true;
      scanBtn.textContent = '扫描中…';
      try {
        const r = await api('/api/browser/extension-scan', { method: 'POST', body: { platform: id, city, query, pages } });
        toast(`BOSS 扫描完成：抓到 ${r.fetched} 条，入库 ${r.kept} 条`);
        state.recs = null;
        await loadStats();
      } catch (e) {
        toast('扫描失败：' + e.message, true);
      }
      await renderLogin();
    };
  });
}

function recSalary(j) {
  return j.salary_raw || (j.salary_min != null ? formatSalary(j) : '面议');
}

function recIncome(v) {
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : `${Math.round(v / 1000)}k`;
}

function diffClass(d) {
  return d <= 30 ? 'low' : d <= 55 ? 'mid' : 'high';
}

async function renderRecommend() {
  $('#view').innerHTML = `<div class="skeleton" style="height:90px;margin-bottom:16px"></div><div class="skeleton" style="height:260px"></div>`;
  state.recs = await api(`/api/recommendations?hours=${state.recHours}`);
  const { high, stacking, stats } = state.recs;
  const budget = state.recHours;

  const highCards = high.map(h => {
    const j = h.job;
    return `<article class="rec-card" data-id="${esc(j.id)}">
      <div class="rec-head">
        <span class="mini-logo" style="background:${logoColor(j.company || j.title)}">${esc(logoText(j.company || j.title))}</span>
        <div class="rec-co">
          <b title="${esc(j.company || '')}">${esc(j.company || '未署名公司')}</b>
          <span class="src ${esc(j.source)}">${SOURCE_NAME[j.source] || j.source}</span>
        </div>
        <div class="rec-score"><b>${h.score}</b><small>匹配</small></div>
      </div>
      <h3 class="rec-title">${esc(j.title)}</h3>
      <div class="rec-meta">
        <span class="salary ${j.salary_min == null ? 'muted' : ''}">${esc(recSalary(j))}</span>
        <span class="loc">📍 ${esc(j.location || '—')}</span>
        ${j.remote ? '<span class="badge-remote">远程</span>' : ''}
      </div>
      <p class="rec-reason">${esc(h.reason)}</p>
      <div class="rec-foot">
        <span class="rec-gaps">${h.gaps.length ? '长期项：' + h.gaps.map(esc).join('、') : '无硬缺口'}</span>
        <button class="btn btn-brass btn-sm" data-rec-apply="${esc(j.id)}">投递</button>
      </div>
    </article>`;
  }).join('') || '<div class="empty" style="grid-column:1/-1;padding:30px">暂无高匹配岗位，先去扫一轮</div>';

  const comboCards = stacking.combos.map((c, i) => `
    <div class="combo-card">
      <div class="combo-head">
        <span class="combo-tag">组合 ${i + 1} · ${c.size} 份</span>
        <span class="combo-income">¥${recIncome(c.totalIncome)}<small>/月</small></span>
      </div>
      <div class="combo-jobs">
        ${c.jobs.map(x => `<div class="combo-job" data-id="${esc(x.job.id)}">
          <span class="mini-logo" style="background:${logoColor(x.job.company || x.job.title)}">${esc(logoText(x.job.company || x.job.title))}</span>
          <div class="combo-job-main">
            <b>${esc(x.job.title)}</b>
            <span>${esc(x.job.company || '未署名')} · ¥${recIncome(x.income)}/月${x.estimatedIncome ? '（估）' : ''} · 交付难度 ${x.difficulty} · ~${x.hours}h/周</span>
          </div>
          <span class="stack-badge ${diffClass(x.difficulty)}">可叠加 ${x.stackability}</span>
        </div>`).join('')}
      </div>
      <div class="combo-foot">
        <span>合计 ~${c.totalHours} 小时/周</span>
        <span>平均可叠加 ${c.avgStack}</span>
        <span>缺口学习 ${c.jobs.reduce((n, x) => n + x.learnDays, 0)} 天</span>
      </div>
      <p class="combo-note">${esc(c.note)}</p>
    </div>`).join('') || `<div class="note-box">${budget} 小时/周装不下两份交付级别的远程岗。试试放宽到 60 小时，或只挑一份「可叠加」最高的先干。</div>`;

  const stackRows = stacking.candidates.slice(0, 6).map(c => `
    <div class="stack-row" data-id="${esc(c.job.id)}">
      <div class="stack-main">
        <div class="stack-title">${esc(c.job.title)}</div>
        <div class="stack-sub">${esc(c.job.company || '未署名')} · ¥${recIncome(c.income)}/月${c.estimatedIncome ? '（面议，按 15k 估）' : ''} · ${c.job.remote ? '远程' : ''}</div>
        <div class="stack-risks">${c.risks.length ? c.risks.map(r => `<span class="risk-chip">${esc(r)}</span>`).join('') : '<span class="risk-chip ok">未识别到明显叠加风险</span>'}</div>
      </div>
      <div class="stack-metrics">
        <div class="metric"><span>交付难度 ${c.difficulty}</span><div class="metric-track"><i class="${diffClass(c.difficulty)}" style="width:${c.difficulty}%"></i></div></div>
        <div class="metric"><span>可叠加 ${c.stackability}</span><div class="metric-track"><i class="stack" style="width:${c.stackability}%"></i></div></div>
        <div class="metric"><span>~${c.hours}h/周 · 缺口 ${c.learnDays} 天</span></div>
      </div>
    </div>`).join('') || '<div class="empty" style="padding:30px">没有可叠加的远程岗</div>';

  $('#view').innerHTML = `
    <div class="rec-hero">
      <div class="rec-hero-text">
        <h2>今天投什么</h2>
        <p>第一段是匹配高、几乎不用补课的，先投。第二段是远程叠加：大部分岗是全职，但如果远程、交付轻、文化异步，就可以同时接 2 份；缺口能用 AI 补的不算门槛，真正要算的是交付难度和时间冲突。</p>
      </div>
      <div class="rec-stats">
        <div><b>${stats.highCount}</b><span>可直接投</span></div>
        <div><b>${stats.remoteCount}</b><span>远程可叠加</span></div>
        <div><b>${stats.comboCount}</b><span>推荐组合</span></div>
      </div>
    </div>

    <div class="section-label">一 · 现在就能投（匹配高、要补的课少）<button class="btn btn-ghost btn-sm" id="recRefresh" style="margin-left:auto">刷新</button></div>
    <div class="rec-grid">${highCards}</div>

    <div class="section-label">二 · 远程叠加：用时间换收益</div>
    <div class="budget-row">
      <span>我每周最多投入：</span>
      ${[40, 50, 60].map(n => `<button class="budget ${budget === n ? 'active' : ''}" data-hours="${n}">${n} 小时</button>`).join('')}
      <span class="hint" style="margin-left:6px">一份全职按 40h 算；交付轻的按实际有效工时估</span>
    </div>
    <div class="combo-grid">${comboCards}</div>

    <div class="section-label">单岗可叠加性（从高到低）</div>
    <div class="stack-list">${stackRows}</div>

    <div class="note-box" style="margin-top:18px">
      <b>交付难度怎么估：</b>驻场/客户现场/售前 +32，时区重叠 +22，管理/负责人 +16，会议密度 +12，英文口语 +10；提到 async/结果导向 −22，兼职/项目制 −18。难度越低、越异步，越适合叠加。
      周工时 = 14 + 难度×0.28（兼职从 8 起）；「面议」按 15k/月估，只用于排序。
      <br/><b>风险：</b>全职合同常有兼职/竞业条款，叠加前先确认合同；时区冲突的组合已排除，但会议密度只能估，不能保证。
    </div>`;

  $('#recRefresh').onclick = async () => { state.recs = null; await renderRecommend(); };
  $$('[data-hours]').forEach(b => b.onclick = async () => {
    state.recHours = Number(b.dataset.hours);
    state.recs = null;
    await renderRecommend();
  });
}

function renderApplications() {
  const rows = state.applications;
  $('#view').innerHTML = rows.length ? `
    <div class="table-wrap">
      <table>
        <thead><tr><th>岗位 / 公司</th><th>薪资</th><th>简历</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>${rows.map(a => `
          <tr data-id="${esc(a.job_id)}">
            <td>
              <div class="cell-title">${esc(a.title)}</div>
              <div class="cell-sub">${esc(a.company || '未署名')} · ${SOURCE_NAME[a.source] || a.source}${a.remote ? ' · 远程' : ''}</div>
            </td>
            <td>${esc(a.salary_raw || '—')}</td>
            <td class="cell-sub" style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.resume_name || '')}">${esc(a.resume_name || '—')}</td>
            <td>
              <select class="status-select" data-status="${esc(a.job_id)}">
                ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${a.status === k ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </td>
            <td>${fmtDate(a.updated_at)}</td>
            <td>
              <button class="btn btn-ghost btn-sm" data-open="${esc(a.job_id)}">查看</button>
              <button class="btn btn-ghost btn-sm" data-del="${esc(a.job_id)}">删除</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<div class="empty"><div class="big">✉</div><h3>还没有投递记录</h3><p>在岗位卡片上点「投递」，生成求职信并标记状态后，这里会显示进度。</p></div>`;

  $$('[data-status]').forEach(sel => sel.onchange = async () => {
    const jobId = sel.dataset.status;
    const a = state.applications.find(x => x.job_id === jobId);
    try {
      await api('/api/applications', { method: 'POST', body: { job_id: jobId, status: sel.value, note: a?.note, cover_letter: a?.cover_letter, resume_name: a?.resume_name } });
      toast(`已更新为「${STATUS[sel.value]}」`);
      await loadApplications(); await loadStats();
    } catch (e) { toast('更新失败', true); }
  });
  $$('[data-del]').forEach(b => b.onclick = async () => {
    await api(`/api/applications/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
    toast('已删除'); await loadApplications(); await renderApplications(); await loadStats();
  });
  $$('[data-open]').forEach(b => b.onclick = () => openJob(b.dataset.open));
}

function renderSettings() {
  const s = state.stats || {};
  const resumes = state.resumes || [];
  $('#view').innerHTML = `
    <div class="settings-grid">
      <div class="panel">
        <div class="panel-head"><h3>简历文件</h3><span>投递时从本地选择</span></div>
        <div class="resume-list">
          ${resumes.length ? resumes.map(r => `
            <div class="resume-item">
              <div>
                <div class="rname">${esc(r.name)} ${r.isDefault ? '<span class="src jobui">默认</span>' : ''}</div>
                <div class="rmeta">${(r.size / 1024).toFixed(0)} KB · ${fmtDate(r.mtime)}</div>
              </div>
              <span class="spacer"></span>
              <a class="btn btn-ghost btn-sm" href="/api/resume?name=${encodeURIComponent(r.name)}" target="_blank">预览</a>
            </div>`).join('') : '<div class="note-box">没有找到 PDF。把简历放进 <span class="mono">data/resumes/</span>，或设置 <span class="mono">RESUME_DIR</span> 指向外部目录。</div>'}
        </div>
        <div class="hint">当前默认简历用于生成投递包；投递前请确认版本是最新的。</div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>搜索方向</h3><span>全局主控</span></div>
        <div class="dir-current" id="settingsDirection"></div>
        <button class="btn btn-primary btn-sm" id="settingsDirectionBtn" style="margin-top:10px">调整搜索方向</button>
        <div class="hint" style="margin-top:8px">方向决定下一轮扫描抓什么；只有重新扫描才会更新整个列表、相关度和投递建议。</div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>扫描</h3><span>自动 + 手动</span></div>
        <div class="kv"><span class="k">最近完成</span><span>${s.lastScan?.finished_at ? new Date(s.lastScan.finished_at).toLocaleString('zh-CN') : '—'}</span></div>
        <div class="kv"><span class="k">自动频率</span><span>每 6 小时（服务运行时）</span></div>
        <div class="kv"><span class="k">上一轮新增</span><span>${s.lastScan?.stats?.added ?? '—'}</span></div>
        <div class="kv"><span class="k">职友集冷却</span><span>${state.cooldownUntil ? new Date(state.cooldownUntil).toLocaleString('zh-CN') : '无'}</span></div>
        <div class="apply-row" style="margin-top:14px">
          <button class="btn btn-primary" id="scanNow">按当前方向重扫</button>
          <a class="btn btn-ghost" href="/api/export?format=csv">导出 CSV</a>
          <a class="btn btn-ghost" href="/api/export" target="_blank">导出 JSON</a>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>数据源</h3><span>抓取方式与边界</span></div>
        <div class="kv"><span class="k">职友集 jobui.com</span><span>关键词站内搜索</span></div>
        <div class="kv"><span class="k">中华英才 chinahr.com</span><span>关键词搜索 API</span></div>
        <div class="kv"><span class="k">小红书 xiaohongshu.com</span><span>招聘笔记，需登录</span></div>
        <div class="kv"><span class="k">电鸭 eleduck.com</span><span>全量岗位流 + 关键词过滤</span></div>
        <div class="kv"><span class="k">远程.work</span><span>站内关键词搜索</span></div>
        <div class="kv"><span class="k">RemoteOK</span><span>全量 API + 关键词过滤</span></div>
        <div class="kv"><span class="k">Remotive</span><span>API 关键词搜索</span></div>
        <div class="kv"><span class="k">Jobicy</span><span>全量 API + 关键词过滤</span></div>
        <div class="kv"><span class="k">Working Nomads</span><span>全量 API + 关键词过滤</span></div>
        <div class="note-box" style="margin-top:10px">有搜索接口的源直接把关键词传给平台；没有搜索接口的源只能抓全量后按词过滤，日志里会写「搜索」还是「第 N 页」。</div>
        <div class="note-box" style="margin-top:10px">Boss直聘 / 猎聘 / 智联 有登录与反爬限制，本工具不直接抓；职友集卡片里的「原站链接」会指向这些站点，点「打开原站」即可投递。</div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>平台登录</h3><span>高风险</span></div>
        <div class="note-box">BOSS / 小红书：登录后可扫描。We Work Remotely / 猎聘 / 智联 / 51job / 58 属于付费平台，只支持去原站投递；不付费可能无法投递，本工具不代付、不绕过。</div>
        <a class="btn btn-primary btn-sm" href="#/login" style="margin-top:12px;display:inline-flex">打开平台登录</a>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>投递邮箱</h3><span>SMTP · 只存本机</span></div>
        <div class="mail-form">
          <label>邮箱地址<input class="input" id="mailUser" value="${esc(state.emailConfig?.user || '')}" placeholder="you@qq.com"/></label>
          <label>SMTP 服务器<input class="input" id="mailHost" value="${esc(state.emailConfig?.host || '')}" placeholder="smtp.qq.com"/></label>
          <label>端口<input class="input" id="mailPort" value="${esc(state.emailConfig?.port || 465)}"/></label>
          <label>授权码<input class="input" id="mailPass" type="password" placeholder="留空则不修改"/></label>
          <label>发件人名称<input class="input" id="mailFromName" value="${esc(state.emailConfig?.fromName || '')}" placeholder="你的名字"/></label>
        </div>
        <div class="apply-row" style="margin-top:10px">
          <button class="btn btn-primary btn-sm" id="saveMail">保存</button>
          <button class="btn btn-ghost btn-sm" id="testMail">测试连接</button>
          <span class="hint" id="mailCfgStatus">${state.emailConfig?.configured ? '已配置' : '未配置'}</span>
        </div>
        <div class="hint" style="margin-top:6px">QQ/163 用「授权码」而不是登录密码；保存到 <span class="mono">data/email.json</span>（权限 600），不上传。常见：QQ <span class="mono">smtp.qq.com:465</span>，163 <span class="mono">smtp.163.com:465</span>，Gmail <span class="mono">smtp.gmail.com:465</span>。</div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>海外岗翻译</h3><span>英文 JD → 中文</span></div>
        <label class="check" style="margin-top:4px"><input type="checkbox" id="autoTranslate" ${localStorage.getItem('autoTranslate') === '1' ? 'checked' : ''}/> 打开岗位时自动翻译英文 JD</label>
        <div class="hint">翻译走 MyMemory 公共接口，结果缓存在本地 SQLite；不会上传简历。</div>
      </div>

      <div class="panel" style="grid-column:1/-1">
        <div class="panel-head"><h3>简历画像</h3><span>config/profile.json · 改完自动重算匹配</span></div>
        <textarea id="profileJson" class="input mono" style="width:100%;height:260px;line-height:1.55" spellcheck="false">${state.profile?.profile ? esc(JSON.stringify(state.profile.profile, null, 2)) : '加载中…'}</textarea>
        <div class="apply-row" style="margin-top:8px">
          <button class="btn btn-primary btn-sm" id="saveProfile">保存并重算匹配</button>
          <span class="hint" id="profileStatus">这是开源版本的核心：任何用户改这里，就能用自己的简历画像搜索。</span>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>投递口径</h3><span>简历定位</span></div>
        <div class="note-box">
          目标岗位：AI Agent / FDE / AI 应用落地。<br/>
          匹配分：硬性条件 / AI 能力 / 工程部署 / 业务交付 四维加权，权重取自 JD 出现位置。<br/>
          投递：生成定制简历 → 复制求职信 → 打开原站 → 记录状态；不自动提交。
        </div>
      </div>
    </div>`;

  $('#scanNow').onclick = openDirection;
  $('#settingsDirectionBtn').onclick = openDirection;
  const sd = $('#settingsDirection');
  if (sd) sd.innerHTML = directionSummaryHTML();
  const saveMail = $('#saveMail');
  if (saveMail) saveMail.onclick = async () => {
    const status = $('#mailCfgStatus');
    try {
      state.emailConfig = await api('/api/email/config', {
        method: 'POST',
        body: {
          user: $('#mailUser').value, host: $('#mailHost').value, port: Number($('#mailPort').value),
          pass: $('#mailPass').value, fromName: $('#mailFromName').value, secure: Number($('#mailPort').value) !== 587,
        },
      });
      status.textContent = '已保存';
      toast('投递邮箱已保存');
    } catch (e) { status.textContent = '保存失败：' + e.message; toast('保存失败', true); }
  };
  const testMail = $('#testMail');
  if (testMail) testMail.onclick = async () => {
    const status = $('#mailCfgStatus');
    status.textContent = '测试中…';
    try { await api('/api/email/test', { method: 'POST' }); status.textContent = '连接成功'; toast('SMTP 连接成功'); }
    catch (e) { status.textContent = '失败：' + e.message; toast('连接失败', true); }
  };

  const auto = $('#autoTranslate');
  if (auto) auto.onchange = () => localStorage.setItem('autoTranslate', auto.checked ? '1' : '0');
  const saveProfile = $('#saveProfile');
  if (saveProfile) saveProfile.onclick = async () => {
    const status = $('#profileStatus');
    try {
      const obj = JSON.parse($('#profileJson').value);
      const r = await api('/api/profile', { method: 'POST', body: { profile: obj } });
      state.profile = { profile: r.profile };
      status.textContent = '已保存，匹配分已重算';
      state.recs = null;
      toast('简历画像已更新');
      await loadStats();
    } catch (e) {
      status.textContent = '保存失败：' + e.message;
      toast('保存失败：' + e.message, true);
    }
  };
  $$('#view .btn-ghost[href="/api/export?format=csv"]').forEach(a => a.onclick = () => { location.href = a.href; });
}

// ---------------- drawer ----------------
let drawerState = null;

const STATUS_LABEL = { hit: '命中', partial: '部分', miss: '缺失' };
const PRI_CLASS = { 高: '高', 中: '中', 低: '低' };

function scoreColor(v) {
  return v >= 70 ? 'var(--green)' : v >= 45 ? 'var(--brass)' : '#b4674f';
}

function ringSvg(score) {
  const r = 46, c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `<div class="score-ring">
    <svg width="104" height="104" viewBox="0 0 104 104">
      <circle cx="52" cy="52" r="${r}" fill="none" stroke="#f0ebe0" stroke-width="9"/>
      <circle cx="52" cy="52" r="${r}" fill="none" stroke="${scoreColor(score)}" stroke-width="9"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"/>
    </svg>
    <div class="num">${score}<small>/100</small></div>
  </div>`;
}

function reqPanelHTML(job, a) {
  const hard = a.items.filter(i => i.kind === 'hard');
  const skills = a.items.filter(i => i.kind === 'skill');
  const hardChips = hard.map(i => `<span class="hard-chip">${esc(i.label)}
    <span class="${i.status === 'hit' ? 'ok' : i.status === 'partial' ? 'part' : 'no'}">· ${STATUS_LABEL[i.status]}</span>
    <span>${esc(i.mine)}</span></span>`).join('');
  const skillChips = skills.map(i => `<span class="skill-chip ${i.status}" title="${esc(i.mine)}">${esc(i.label)}<i>×${i.weight}</i></span>`).join('');
  const dutyList = a.jd.duties.length
    ? `<ul class="bullets">${a.jd.duties.map(d => `<li>${esc(d)}</li>`).join('')}</ul>`
    : `<div class="note-box">该来源没有提供岗位职责。点「打开原站」看完整 JD。</div>`;
  const reqList = a.jd.requirements.length
    ? `<ul class="bullets">${a.jd.requirements.map(d => `<li>${esc(d)}</li>`).join('')}</ul>`
    : '';
  return `
    <div class="req-block">
      <h5>硬性条件</h5>
      <div class="hard-chips">${hardChips || '<span class="hint">未识别到明确硬性条件</span>'}</div>
    </div>
    <div class="req-block">
      <h5>技能要求（× 为权重）</h5>
      <div class="skill-chips">${skillChips || '<span class="hint">未识别到技能关键词</span>'}</div>
      <div class="hint">绿色=简历有直接证据；黄色=部分可迁移；灰色划掉=目前缺失。悬停看我的证据。</div>
    </div>
    <div class="req-block">
      <h5>招聘方职责</h5>
      ${dutyList}
    </div>
    ${reqList ? `<div class="req-block"><h5>任职要求原文</h5>${reqList}</div>` : ''}
    <div class="section-label">JD 原文
      ${job.channel === 'overseas' ? '<button class="btn btn-ghost btn-sm" id="translateBtn">译成中文</button>' : ''}
      ${(job.original_url || '').includes('ncss.cn') ? '<button class="btn btn-ghost btn-sm" id="fetchJdBtn">抓取完整 JD</button>' : ''}
    </div>
    <div class="jd" id="jdText">${esc(a.jd.raw || job.summary || '无')}</div>
    ${!a.jd.hasJd ? '<div class="hint">该来源只提供卡片信息；完整 JD 请点底部「打开原站投递」查看。</div>' : ''}`;
}

function matchPanelHTML(job, a) {
  const dims = a.dims.map(d => `
    <div class="dim"><div class="l"><span>${d.name}</span><b>${d.score}</b></div>
      <div class="bar"><i style="width:${d.score}%"></i></div></div>`).join('');
  const rows = [...a.items].sort((x, y) => y.weight - x.weight).slice(0, 14).map(i => `
    <tr><td>${esc(i.label)}</td><td class="w">×${i.weight}</td>
      <td class="mine">${esc(i.mine)}</td>
      <td><span class="pill ${i.status}">${STATUS_LABEL[i.status]}</span></td></tr>`).join('');
  const sugg = a.suggestions.map(g => `
    <div class="sugg"><span class="pri ${PRI_CLASS[g.priority] || ''}">${esc(g.priority)}</span>
      <div class="t"><b>${esc(g.label)}</b>${esc(g.text)}</div></div>`).join('');
  const kws = a.keywords.map(k => `<span class="skill-chip ${k.hit ? 'hit' : k.partial ? 'partial' : 'miss'}">${esc(k.term)}</span>`).join('');
  const conf = a.confidence === 'low' ? '<span class="conf low">低置信 · 来源无完整 JD</span>' : `<span class="conf">依据 ${a.items.length} 项要求</span>`;
  return `
    <div class="score-row">
      ${ringSvg(a.score)}
      <div class="score-meta">
        <h4>简历与这个岗位的加权匹配 ${conf}</h4>
        <p>按「硬性条件 / AI 能力 / 工程部署 / 业务交付」加权；每项要求按出现位置（标题 &gt; 要求 &gt; 职责）给权重。分数只反映已有证据，不代表面试结果。</p>
      </div>
    </div>
    <div class="dim-grid">${dims}</div>
    <div class="section-label">逐项对照</div>
    <table class="match-table"><thead><tr><th>要求</th><th>权重</th><th>我的情况</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="section-label">优化建议</div>
    ${sugg}
    <div class="section-label">JD 关键词覆盖</div>
    <div class="kw-row">${kws || '<span class="hint">无</span>'}</div>`;
}

function applyPanelHTML(job, analysis, cover) {
  const resumes = state.resumes || [];
  return `
    <div class="tailor-box">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
        <b style="font-size:13px">按这个 JD 生成定制简历</b>
        <span class="conf">匹配 ${analysis.score}</span>
      </div>
      <ul class="checklist">
        <li>概述第一句按命中项重写，前 12 个字先给结论</li>
        <li>关键词按 JD 词频重排，只放你真有证据的</li>
        <li>缺口技能不写入简历，避免面试被追问</li>
      </ul>
      <div class="tailor-actions">
        <button class="btn btn-brass btn-sm" id="tailorBtn">生成定制 PDF</button>
        <a class="btn btn-ghost btn-sm panel-hidden" id="tailorLink" target="_blank">打开定制简历</a>
      </div>
      <div class="tailor-status" id="tailorStatus">生成后自动选中，作为本次投递附件。</div>
    </div>

    <div class="section-label">一键邮件投递</div>
    <div class="mail-box">
      <div class="apply-row">
        <input class="input" id="mailTo" style="flex:1;min-width:200px" placeholder="收件邮箱（JD 里没有就手填）" value="${esc(drawerState.applyEmail || '')}" />
        <button class="btn btn-brass btn-sm" id="sendMailBtn" ${(state.emailConfig?.configured || drawerState.emailConfigured) ? '' : 'disabled'}>发送简历</button>
      </div>
      <div class="hint">${(state.emailConfig?.configured || drawerState.emailConfigured)
        ? '会用你的 SMTP 把求职信 + 简历 PDF 发给对方；发送后自动记为「已投递」。'
        : '还没配置投递邮箱，去「设置 → 投递邮箱」填 SMTP 后才能用。'}</div>
      <div class="hint">BOSS/猎聘/智联这类要登录的平台，请用抽屉底部「打开原站投递」。</div>
    </div>

    <div class="section-label">求职信</div>
    <div class="apply-box">
      <textarea id="coverText">${esc(cover)}</textarea>
      <input class="input" id="noteText" style="width:100%;margin-top:10px" placeholder="备注：HR 微信 / 内推人 / 面试时间…" value="${esc(job.apply?.note || '')}" />
      <div class="apply-row">
        <select id="resumeSel" style="flex:1;min-width:200px">
          ${resumes.map(r => `<option value="${esc(r.name)}" ${(job.apply?.resume_name || '') === r.name ? 'selected' : ''}>${esc(r.name)}${r.tailored ? '（定制）' : ''}</option>`).join('')}
        </select>
        <select id="statusSel">
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${(job.apply?.status || 'todo') === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="apply-row" style="margin-top:8px">
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" id="copyCover">复制求职信</button>
        <button class="btn btn-brass btn-sm" id="saveApply">保存状态</button>
      </div>
      <div class="hint">「打开原站」会跳到招聘方页面，简历需要你手动上传；本工具不自动提交，避免封号。</div>
    </div>`;
}

function renderDrawer() {
  const { job, analysis, cover, tab } = drawerState;
  const t = tab || 'req';
  $('#drawerInner').innerHTML = `
    <div class="drawer-head">
      <span class="logo" style="background:${logoColor(job.company || job.title)}">${esc(logoText(job.company || job.title))}</span>
      <div>
        <div style="font-size:13px;font-weight:600">${esc(job.company || '未署名公司')}</div>
        <div style="font-size:11.5px;color:var(--faint);margin-top:2px">${SOURCE_NAME[job.source] || job.source} · ${fmtDate(job.posted_at)}</div>
      </div>
      <button class="drawer-close" id="drawerClose">✕</button>
    </div>
    <h2>${esc(job.title)}</h2>
    <div class="zh-title ${drawerState.translation ? '' : 'panel-hidden'}" id="zhTitle">${esc(drawerState.translation?.title_zh || '')}</div>
    ${job.source === 'xhs' ? `<div class="xhs-hero">
      ${job.cover_url ? `<a href="${esc(job.original_url || job.url)}" target="_blank" rel="noopener"><img src="${esc(job.cover_url)}" referrerpolicy="no-referrer" alt=""/></a>` : ''}
      <div class="xhs-meta">
        <div><b>${esc(job.company || '未署名作者')}</b></div>
        <div>${job.note_likes ? `❤ ${esc(job.note_likes)}` : '点赞数未抓到'} · 小红书笔记</div>
        <a href="${esc(job.original_url || job.url)}" target="_blank" rel="noopener">在浏览器打开笔记 ↗</a>
        <div class="hint">笔记正文由小红书动态渲染，链接带时效 token；这里展示的是扫描时抓到的标题/作者/封面/点赞。</div>
      </div>
    </div>` : ''}
    <div class="job-meta" style="margin-top:2px">
      <span class="salary ${job.salary_min == null ? 'muted' : ''}">${esc(job.salary_raw || (job.salary_min != null ? formatSalary(job) : '面议'))}</span>
      <span class="loc">📍 ${esc(job.location || '—')}</span>
      ${job.remote ? `<span class="badge-remote">远程</span>` : ''}
      <span class="match ${analysis.score >= 70 ? 'high' : analysis.score >= 45 ? 'mid' : ''}"><span class="match-dot"></span>简历匹配 ${analysis.score}</span>
    </div>

    <div class="tabs">
      <button class="tab-btn ${t === 'req' ? 'active' : ''}" data-tab="req">招聘方需求</button>
      <button class="tab-btn ${t === 'match' ? 'active' : ''}" data-tab="match">简历对比 · 优化</button>
      <button class="tab-btn ${t === 'apply' ? 'active' : ''}" data-tab="apply">投递</button>
    </div>

    <div class="tab-panel ${t !== 'req' ? 'panel-hidden' : ''}" data-panel="req">${reqPanelHTML(job, analysis)}</div>
    <div class="tab-panel ${t !== 'match' ? 'panel-hidden' : ''}" data-panel="match">${matchPanelHTML(job, analysis)}</div>
    <div class="tab-panel ${t !== 'apply' ? 'panel-hidden' : ''}" data-panel="apply">${applyPanelHTML(job, analysis, cover)}</div>

    <div class="drawer-foot">
      <a class="btn btn-primary" href="${esc(job.original_url || job.url)}" target="_blank" rel="noopener">打开原站投递 ↗</a>
      ${job.apply ? `<button class="btn btn-ghost" id="delApply">删除记录</button>` : ''}
    </div>`;

  $('#drawer').classList.add('open');
  $('#scrim').classList.add('show');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawerClose').onclick = closeDrawer;

  $$('.tab-btn').forEach(btn => btn.onclick = () => {
    drawerState.tab = btn.dataset.tab;
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    $$('.tab-panel').forEach(p => p.classList.toggle('panel-hidden', p.dataset.panel !== btn.dataset.tab));
  });

  const fetchJdBtn = $('#fetchJdBtn');
  if (fetchJdBtn) fetchJdBtn.onclick = async () => {
    fetchJdBtn.disabled = true;
    fetchJdBtn.textContent = '抓取中…';
    try {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/fetch-jd`, { method: 'POST' });
      toast('完整 JD 已抓取');
      await openJob(job.id, 'req');
    } catch (e) {
      toast('抓取失败：' + e.message, true);
      fetchJdBtn.disabled = false;
      fetchJdBtn.textContent = '抓取完整 JD';
    }
  };

  const translateBtn = $('#translateBtn');
  if (translateBtn) {
    const apply = () => {
      const tr = drawerState.translation;
      if (!tr) return;
      $('#jdText').textContent = drawerState.showZh ? tr.summary_zh : (analysis.jd.raw || job.summary || '无');
      $('#zhTitle').textContent = drawerState.showZh ? tr.title_zh : '';
      $('#zhTitle').classList.toggle('panel-hidden', !drawerState.showZh);
      translateBtn.textContent = drawerState.showZh ? '看原文' : '译成中文';
    };
    translateBtn.onclick = async () => {
      if (drawerState.translation) {
        drawerState.showZh = !drawerState.showZh;
        apply();
        return;
      }
      translateBtn.disabled = true;
      translateBtn.textContent = '翻译中…';
      try {
        const tr = await api(`/api/jobs/${encodeURIComponent(job.id)}/translate`, { method: 'POST' });
        drawerState.translation = tr;
        drawerState.showZh = true;
        apply();
      } catch (e) {
        toast('翻译失败：' + e.message, true);
        translateBtn.textContent = '译成中文';
      } finally {
        translateBtn.disabled = false;
      }
    };
    if (localStorage.getItem('autoTranslate') === '1' && !drawerState.translation) {
      setTimeout(() => translateBtn.click(), 100);
    }
  }

  const sendMailBtn = $('#sendMailBtn');
  if (sendMailBtn) sendMailBtn.onclick = async () => {
    const to = $('#mailTo').value.trim();
    if (!to) { toast('先填收件邮箱', true); return; }
    sendMailBtn.disabled = true;
    sendMailBtn.textContent = '发送中…';
    try {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/apply-email`, {
        method: 'POST',
        body: { to, cover_letter: $('#coverText').value, resume_name: $('#resumeSel').value, note: $('#noteText').value },
      });
      toast('已发送并记为已投递');
      closeDrawer();
      await loadStats();
      if (['local', 'remote', 'overseas', 'search'].includes(state.view)) await renderJobs();
      else await render();
    } catch (e) {
      toast('发送失败：' + e.message, true);
      sendMailBtn.disabled = false;
      sendMailBtn.textContent = '发送简历';
    }
  };

  const copyBtn = $('#copyCover');
  if (copyBtn) copyBtn.onclick = async () => {
    await navigator.clipboard.writeText($('#coverText').value);
    toast('求职信已复制');
  };

  const saveBtn = $('#saveApply');
  if (saveBtn) saveBtn.onclick = async () => {
    await api('/api/applications', {
      method: 'POST',
      body: {
        job_id: job.id, status: $('#statusSel').value, cover_letter: $('#coverText').value,
        resume_name: $('#resumeSel').value, note: $('#noteText').value,
      },
    });
    toast('已保存投递状态');
    closeDrawer();
    await loadStats();
    if (state.view === 'applications') { await loadApplications(); renderApplications(); }
    else if (['local', 'remote', 'overseas', 'search'].includes(state.view)) await renderJobs();
    else await render();
  };

  const tailorBtn = $('#tailorBtn');
  if (tailorBtn) tailorBtn.onclick = async () => {
    tailorBtn.disabled = true;
    const status = $('#tailorStatus');
    status.className = 'tailor-status';
    status.textContent = '正在生成 PDF（约 1–2 秒）…';
    try {
      const r = await api(`/api/jobs/${encodeURIComponent(job.id)}/tailor`, { method: 'POST' });
      drawerState.tailored = r;
      status.className = 'tailor-status ok';
      status.textContent = `已生成：${r.name}。已按 JD 重排关键词，缺口技能未写入。`;
      const link = $('#tailorLink');
      link.href = r.url;
      link.classList.remove('panel-hidden');
      state.resumes = await api('/api/resumes');
      const sel = $('#resumeSel');
      const opt = document.createElement('option');
      opt.value = r.name; opt.textContent = r.name + '（定制）'; opt.selected = true;
      sel.prepend(opt);
      toast('定制简历已生成');
    } catch (e) {
      status.className = 'tailor-status';
      status.textContent = '生成失败：' + e.message;
      toast('定制简历生成失败', true);
    } finally {
      tailorBtn.disabled = false;
      tailorBtn.textContent = '重新生成';
    }
  };

  const del = $('#delApply');
  if (del) del.onclick = async () => {
    await api(`/api/applications/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
    toast('已删除投递记录'); closeDrawer(); await loadStats(); await render();
  };
}

async function openJob(id, tab = 'req') {
  try {
    const [data, coverRes] = await Promise.all([
      api(`/api/jobs/${encodeURIComponent(id)}/analysis`),
      api(`/api/cover-letter?job_id=${encodeURIComponent(id)}`).catch(() => ({ text: '' })),
    ]);
    const { job, analysis } = data;
    drawerState = {
      job, analysis, cover: job.apply?.cover_letter || coverRes.text || '', tab, tailored: null,
      translation: data.translation || null, showZh: false,
      applyEmail: data.applyEmail || '', emailConfigured: !!data.emailConfigured,
    };
    renderDrawer();
  } catch (e) {
    console.error(e);
    toast('加载岗位分析失败', true);
  }
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('show');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

// ---------------- scan ----------------
async function startScan() {
  try {
    await api('/api/scan', { method: 'POST' });
    toast('扫描已开始');
    setScanState(true);
  } catch (e) {
    toast('扫描启动失败（可能正在运行）', true);
  }
}

function setScanState(running, text) {
  state.scanRunning = running;
  const el = $('#scanState');
  el.classList.toggle('live', running);
  $('#scanText').textContent = text || (running ? '正在扫描…' : '空闲');
  $('#scanBtn').disabled = running;
}

async function pollScan() {
  try {
    const st = await api('/api/scan/status');
    const idle = st.lastScanAt ? `空闲 · ${new Date(st.lastScanAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新` : '空闲';
    setScanState(st.running, st.running ? `正在扫描… ${st.log?.[st.log.length - 1]?.slice(0, 24) || ''}` : idle);
    state.cooldownUntil = st.cooldownUntil;
    if (!st.running && state.wasRunning) {
      state.wasRunning = false;
      state.searchConfig = await api('/api/search-config').catch(() => state.searchConfig);
      state.directionDirty = false;
      localStorage.removeItem('radar_direction_dirty');
      await loadStats();
      await render();
      renderScopeBar();
      toast('扫描完成，已刷新');
    }
    if (st.running) state.wasRunning = true;
  } catch { /* ignore */ }
}

// ---------------- events ----------------
$('#scanBtn').onclick = openDirection;
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
$('#globalSearch').oninput = debounce((e) => {
  state.filters.q = e.target.value.trim();
  if (['local', 'remote', 'overseas'].includes(state.view)) { render(); return; }
  if (state.filters.q) { location.hash = '#/search'; } else if (state.view === 'search') { location.hash = '#/local'; }
}, 350);

$('#view').addEventListener('click', (e) => {
  const applyBtn = e.target.closest('[data-apply]');
  if (applyBtn) { e.stopPropagation(); openJob(applyBtn.dataset.apply); return; }
  const recApply = e.target.closest('[data-rec-apply]');
  if (recApply) { e.stopPropagation(); openJob(recApply.dataset.recApply, 'apply'); return; }
  const recCard = e.target.closest('.rec-card, .roi-row, .combo-job, .stack-row');
  if (recCard && recCard.dataset.id) { openJob(recCard.dataset.id); return; }
  const card = e.target.closest('.job-card');
  if (card) openJob(card.dataset.id);
});

window.addEventListener('hashchange', route);

(async function init() {
  try {
    await Promise.all([
      loadStats(),
      api('/api/resumes').then(r => (state.resumes = r)),
      api('/api/email/config').then(r => (state.emailConfig = r)).catch(() => null),
      api('/api/search-config').then(r => (state.searchConfig = r)).catch(() => null),
    ]);
  } catch (e) { console.error(e); }
  const st = await api('/api/scan/status').catch(() => ({}));
  setScanState(!!st.running, !st.running && st.lastScanAt ? `空闲 · ${new Date(st.lastScanAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新` : undefined);
  if (st.running) { state.wasRunning = true; }
  bindDirectionModal();
  await route();
  setInterval(pollScan, 3000);
})();
