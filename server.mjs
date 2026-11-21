import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { stat, readdir } from 'node:fs/promises';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { extname, join, normalize, basename } from 'node:path';
import { createReadStream } from 'node:fs';
import {
  queryJobs, getJob, stats, saveApplication, deleteApplication, listApplications,
  startScan, finishScan, lastScanAt, getSetting, setSetting, db,
  allJobsForMatch, setMatchScores, allJobs, saveJobs, updateJobSummary, ncssPending,
  getTranslation, saveTranslation,
  jobsMissingOriginalUrl, countMissingOriginalUrl, setOriginalUrl,
} from './lib/db.mjs';
import { analyzeJob, buildResumeHtml, tailoredFileName, PROFILE, reloadProfile } from './lib/profile.mjs';
import { renderResumePdf } from './lib/tailor.mjs';
import { buildRecommendations } from './lib/strategy.mjs';
import { enrichOriginalUrl, sleep } from './lib/scrape/jobui.mjs';
import { allStatus, openLogin, closeLogin, openScanWindow, status as browserStatus } from './lib/browser-manager.mjs';
import { mapDomJob } from './lib/scrape/zhipin-dom.mjs';
import { mapXhsJob } from './lib/scrape/xhs-dom.mjs';
import { runScan, DEFAULT_SEARCH } from './lib/scrape/index.mjs';
import { scoreRelevance, parseTerms } from './lib/parse.mjs';
import { fetchNcssJd } from './lib/scrape/ncss.mjs';
import { translateText } from './lib/translate.mjs';
import { sendMail, verifyMailbox } from './lib/smtp.mjs';
import { CITIES, platformById } from './lib/platforms.mjs';

const ROOT = import.meta.dirname;
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 7788);
const RESUME_DIRS = [join(ROOT, 'data', 'resumes'), join(ROOT, 'data', 'tailored')];
if (process.env.RESUME_DIR) RESUME_DIRS.push(process.env.RESUME_DIR);
const TAILORED_DIR = join(ROOT, 'data', 'tailored');
const EMAIL_PATH = join(ROOT, 'data', 'email.json');

function keywordCategories() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'config', 'keyword-categories.json'), 'utf8'));
  } catch { return { categories: [] }; }
}

function loadSearchConfig() {
  try {
    const raw = JSON.parse(getSetting('search_config') || 'null');
    if (raw && Array.isArray(raw.keywords) && raw.keywords.length) {
      return { ...DEFAULT_SEARCH, ...raw, keywords: raw.keywords.map(x => String(x).trim()).filter(Boolean).slice(0, 10) };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SEARCH };
}

function readEmailConfig() {
  try { return JSON.parse(readFileSync(EMAIL_PATH, 'utf8')); } catch { return null; }
}
function maskEmail(c) {
  if (!c) return { configured: false };
  return {
    configured: !!(c.host && c.user && c.pass),
    host: c.host, port: c.port, secure: c.secure !== false,
    user: c.user, fromName: c.fromName || '', fromEmail: c.fromEmail || c.user,
  };
}
function safeTags(t) {
  try { return JSON.parse(t || '[]'); } catch { return []; }
}

function extractEmail(text = '') {
  const m = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const bad = /(example\.|sentry|png|jpg|jpeg|gif|webp|@2x)/i;
  return m.find(x => !bad.test(x)) || null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function enrichNcssJobs(limit = 5) {
  let n = 0;
  for (const j of ncssPending(limit)) {
    try {
      const jd = await fetchNcssJd(j.original_url);
      if (jd) { updateJobSummary(j.id, `${jd}\n\n${j.summary || ''}`.trim()); n++; }
    } catch { /* ignore */ }
    await sleep(400);
  }
  if (n) recomputeMatches();
  return n;
}

// 简历匹配分重算（规则引擎，毫秒级）
function recomputeMatches() {
  const rows = allJobsForMatch();
  const scores = rows.map(r => {
    try { return { id: r.id, score: analyzeJob({ ...r, tags: JSON.parse(r.tags || '[]') }).score }; }
    catch { return { id: r.id, score: 0 }; }
  });
  setMatchScores(scores);
  return scores.length;
}

// ---------- 扫描状态 ----------
const scan = { running: false, startedAt: null, log: [], lastError: null };
let pendingExt = null;

async function doScan() {
  if (scan.running) return { started: false, reason: 'already-running' };
  const cooldown = getSetting('jobui_cooldown_until');
  scan.running = true;
  scan.startedAt = new Date().toISOString();
  scan.log = [];
  scan.lastError = null;
  const scanId = startScan();
  setSetting('last_scan_requested_at', scan.startedAt);
  try {
    const cooling = !!(cooldown && new Date(cooldown) > new Date());
    if (cooling) scan.log.push(`职友集冷却中，跳过该源（至 ${cooldown}）`);
    const searchConfig = loadSearchConfig();
    scan.log.push(`关键词：${searchConfig.keywords.join(' / ')} · 城市：${searchConfig.city}`);
    const { stats: st, log } = await runScan({
      skipJobui: cooling,
      config: searchConfig,
      onLog: (m) => { scan.log.push(m); if (scan.log.length > 300) scan.log.shift(); },
    });
    recomputeMatches();
    await enrichNcssJobs();
    setSetting('last_scan_config', JSON.stringify(searchConfig));
    finishScan(scanId, 'ok', st, scan.log.join('\n'));
    setSetting('last_scan_finished_at', new Date().toISOString());
    return { started: true, stats: st };
  } catch (e) {
    scan.lastError = e.message;
    finishScan(scanId, 'error', {}, String(e.stack || e));
    return { started: true, error: e.message };
  } finally {
    scan.running = false;
  }
}

// ---------- 简历 ----------
async function listResumes() {
  const out = [];
  for (const dir of RESUME_DIRS) {
    if (!existsSync(dir)) continue;
    const files = await readdir(dir);
    for (const f of files) {
      if (!/\.(pdf|docx?)$/i.test(f)) continue;
      const p = join(dir, f);
      const s = await stat(p);
      out.push({ name: f, dir, size: s.size, mtime: s.mtime.toISOString(), isDefault: f.includes(`${PROFILE.name}_简历`) });
    }
  }
  return out.sort((a, b) => (b.isDefault - a.isDefault) || b.mtime.localeCompare(a.mtime));
}

function resumePath(name) {
  const safe = basename(name);
  for (const dir of RESUME_DIRS) {
    const p = join(dir, safe);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------- 求职信 ----------
function coverLetter(job) {
  const p = PROFILE;
  const text = `${job.title} ${job.summary || ''} ${(job.tags || []).join(' ')}`;
  const focus = [];
  if (/部署|上线|交付|实施/.test(text)) focus.push('部署与交付');
  if (/agent|智能体|工作流/i.test(text)) focus.push('Agent 工作流');
  if (/售前|解决方案|咨询/.test(text)) focus.push('需求翻译与方案');
  if (/数据|看板|分析/.test(text)) focus.push('数据看板');
  if (!focus.length) focus.push('流程自动化');

  const lines = ['您好，', ''];
  lines.push(job.company
    ? `我在${sourceName(job.source)}看到「${job.company}」在招「${job.title}」，方向和我过去做的事重合度很高，想投一份简历。`
    : `我在${sourceName(job.source)}看到「${job.title}」这个岗位，方向和我过去做的事重合度很高，想投一份简历。`);
  lines.push('');
  const position = (p.summary?.[0] || '').replace(/^现在：/, '');
  if (position) lines.push(position);
  const exp = p.experiences?.[0];
  if (exp) {
    lines.push('');
    lines.push(`${exp.company}${exp.role ? ` 任 ${exp.role}` : ''}${exp.period ? `（${exp.period}）` : ''}：${exp.bullets?.[0] || ''}`);
  }
  lines.push('');
  lines.push(`对应这个岗位，我的落点会放在${focus.join('、')}：先问清楚「产出什么、谁验收」，再把流程拆成能自动化的节点，接进现有系统跑起来，而不是停在 demo。`);
  lines.push('');
  lines.push('如果方便，想约 20 分钟聊聊这个岗位现在卡在哪一步、需要什么人先落地。');
  lines.push('');
  lines.push(p.name);
  return lines.join('\n');
}

function sourceName(s) {
  return { jobui: '职友集', eleduck: '电鸭社区', yuancheng: '远程.work', remoteok: 'RemoteOK', remotive: 'Remotive', zhipin: 'BOSS直聘', jobicy: 'Jobicy', workingnomads: 'Working Nomads', chinahr: '中华英才' }[s] || s;
}

// ---------- HTTP ----------
const json = (res, code, data) => {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw new Error('payload too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);

  try {
    // 扩展桥：允许招聘页/本地页跨域 POST
    if (path.startsWith('/api/extension/')) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }

    // ---- API ----
    if (path.startsWith('/api/')) {
      if (path === '/api/health') return json(res, 200, { ok: true, running: scan.running });

      if (path === '/api/jobs' && req.method === 'GET') {
        const q = url.searchParams;
        const channel = q.get('channel') || 'all';
        if (!['all', 'local', 'remote', 'overseas'].includes(channel)) return json(res, 400, { error: 'channel 不合法' });
        const sort = q.get('sort') || 'date';
        if (!['date', 'relevance', 'match', 'salary'].includes(sort)) return json(res, 400, { error: 'sort 不合法' });
        const limitRaw = Number(q.get('limit') ?? 60);
        const offsetRaw = Number(q.get('offset') ?? 0);
        if (!Number.isFinite(limitRaw) || limitRaw < 1) return json(res, 400, { error: 'limit 必须是正整数' });
        if (!Number.isFinite(offsetRaw) || offsetRaw < 0) return json(res, 400, { error: 'offset 必须 ≥0' });
        let minSalary = null;
        if (q.get('minSalary')) {
          const m = Number(q.get('minSalary'));
          if (!Number.isFinite(m) || m < 0) return json(res, 400, { error: 'minSalary 不合法' });
          minSalary = m;
        }
        const direction = q.get('direction') === '1';
        const directionKeywords = direction ? loadSearchConfig().keywords : [];
        const result = queryJobs({
          channel,
          q: (q.get('q') || '').slice(0, 100),
          source: q.get('source') || 'all',
          minSalary,
          relevantOnly: q.get('relevant') === '1',
          sort,
          limit: Math.min(200, Math.floor(limitRaw)),
          offset: Math.floor(offsetRaw),
          keywords: directionKeywords,
        });
        if (directionKeywords.length) {
          result.rows = result.rows.map(j => ({ ...j, relevance: scoreRelevance(j.title, j.tags, j.summary, directionKeywords).score }));
        }
        return json(res, 200, { ...result, directionKeywords });
      }

      const analysisMatch = path.match(/^\/api\/jobs\/(.+)\/analysis$/);
      if (analysisMatch && req.method === 'GET') {
        const job = getJob(analysisMatch[1]);
        if (!job) return json(res, 404, { error: 'not found' });
        return json(res, 200, {
          job, analysis: analyzeJob(job), translation: getTranslation(job.id),
          applyEmail: extractEmail(`${job.summary || ''} ${job.title || ''}`),
          emailConfigured: maskEmail(readEmailConfig()).configured,
        });
      }

      const jdMatch = path.match(/^\/api\/jobs\/(.+)\/fetch-jd$/);
      if (jdMatch && req.method === 'POST') {
        const job = getJob(jdMatch[1]);
        if (!job) return json(res, 404, { error: 'not found' });
        const url = job.original_url || '';
        if (!/ncss\.cn/.test(url)) {
          return json(res, 400, { error: '该来源没有可直接抓取的完整 JD（BOSS/智联/猎聘需要登录，职友集只给卡片）' });
        }
        try {
          const jd = await fetchNcssJd(url);
          if (!jd) return json(res, 504, { error: '原站页面没有解析到 JD' });
          updateJobSummary(job.id, `${jd}\n\n${job.summary || ''}`.trim());
          recomputeMatches();
          return json(res, 200, { ok: true, detail: jd });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }

      const tailorMatch = path.match(/^\/api\/jobs\/(.+)\/tailor$/);
      if (tailorMatch && req.method === 'POST') {
        const job = getJob(tailorMatch[1]);
        if (!job) return json(res, 404, { error: 'not found' });
        const analysis = analyzeJob(job);
        const name = tailoredFileName(job);
        const out = join(TAILORED_DIR, name);
        try {
          await renderResumePdf(buildResumeHtml(job, analysis), out);
          return json(res, 200, {
            name, url: `/api/resume?name=${encodeURIComponent(name)}`,
            score: analysis.score, suggestions: analysis.suggestions,
          });
        } catch (e) {
          return json(res, 500, { error: 'PDF 生成失败: ' + e.message });
        }
      }

      const jobMatch = path.match(/^\/api\/jobs\/(.+)$/);
      if (jobMatch && req.method === 'GET') {
        const job = getJob(jobMatch[1]);
        if (!job) return json(res, 404, { error: 'not found' });
        return json(res, 200, job);
      }

      if (path === '/api/stats') {
        const base = stats();
        const keywords = loadSearchConfig().keywords;
        const directionCount = queryJobs({ channel: 'all', keywords, sort: 'date', limit: 1, offset: 0 }).total;
        return json(res, 200, { ...base, directionCount, directionKeywords: keywords });
      }

      if (path === '/api/extension/ping' && req.method === 'POST') {
        let b = {};
        try { b = await body(req); } catch { /* ignore */ }
        console.log('EXT_PING', JSON.stringify(b).slice(0, 200));
        return json(res, 200, { ok: true, at: new Date().toISOString() });
      }

      if (path === '/api/browser/status') {
        const list = allStatus().map(st => {
          let lastScan = null;
          try { lastScan = JSON.parse(getSetting(`browser_scan_${st.id}`) || 'null'); } catch { /* ignore */ }
          return { ...st, lastScan };
        });
        return json(res, 200, { platforms: list, cities: CITIES });
      }

      if (path === '/api/browser/open' && req.method === 'POST') {
        const b = await body(req);
        const cfg = platformById(b.platform);
        if (!cfg) return json(res, 400, { error: '未知平台' });
        if (!b.consent) return json(res, 403, { error: '需要先确认封号风险' });
        if (pendingExt) return json(res, 409, { error: '扫描进行中，先等扫描结束' });
        setSetting(`risk_ack_${cfg.id}`, new Date().toISOString());
        const st = await openLogin(cfg.id);
        return json(res, 200, st);
      }

      if (path === '/api/browser/close' && req.method === 'POST') {
        const b = await body(req);
        if (!platformById(b.platform)) return json(res, 400, { error: '未知平台' });
        return json(res, 200, await closeLogin(b.platform));
      }

async function runXhsScan(b) {
  const platform = 'xhs';
  const st = browserStatus(platform);
  if (st.browserOpen) return { code: 409, body: { error: '小红书登录窗口还开着，先关闭再扫描' } };
  if (!st.loggedIn) return { code: 401, body: { error: '没检测到小红书登录态。请先打开登录窗口扫码登录' } };
  if (pendingExt) return { code: 409, body: { error: '已有一次扫描在进行中' } };

  const dir = loadSearchConfig();
  const keywords = [...new Set(dir.keywords)].slice(0, 5)
    .map(k => /招聘|招人|内推/.test(k) ? k : `${k} 招聘`);
  const scanId = randomUUID();
  const urls = keywords.map(kw => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}&_radar_scan=${scanId}`);

  pendingExt = { id: scanId, urls, at: Date.now(), jobs: [], resolve: null, timer: null };
  const done = new Promise(resolve => { pendingExt.resolve = resolve; });
  try {
    await openScanWindow(platform, join(ROOT, 'extension'), urls[0]);
  } catch (e) {
    pendingExt = null;
    return { code: 500, body: { error: e.message } };
  }
  const result = await Promise.race([done, sleep(45000).then(() => ({ timeout: true }))]);
  clearTimeout(pendingExt?.timer);
  const lastHtml = pendingExt?.html || '';
  await closeLogin(platform);
  pendingExt = null;

  if (result.timeout) return { code: 504, body: { error: '45 秒内没收到小红书笔记数据（可能被安全校验）' } };
  if (!result.jobs.length) {
    const hint = /登录|扫码/.test(lastHtml) ? '小红书登录态已失效，请重新登录后再扫'
      : /验证|captcha|安全/.test(lastHtml) ? '触发小红书风控验证，停 1 小时再试'
        : '小红书返回 0 条：可能未登录、被风控，或页面结构变了';
    return { code: 422, body: { error: hint } };
  }

  const terms2 = keywords.flatMap(k => k.split(/\s+/)).filter(t => t && !/^(招聘|招人|求职|找工作|岗位)$/.test(t));
  const xhsCity = dir.city || '昆明';
  const seen = new Set();
  const mapped = [];
  for (const r of result.jobs) {
    const key = r.url || r.title;
    if (seen.has(key)) continue;
    seen.add(key);
    const j = mapXhsJob(r, terms2, xhsCity);
    if (j) mapped.push({ ...j, channel: j.remote ? 'remote' : 'local' });
  }
  const r = saveJobs(mapped);
  recomputeMatches();
  const summary = {
    at: new Date().toISOString(), query: keywords.join(' / '), keywords, city: '昆明', pages: 1,
    fetched: result.jobs.length, kept: mapped.length, added: r.added,
    log: [`小红书笔记 ${result.jobs.length} 条`, `符合招聘+昆明/远程 ${mapped.length} 条`, `入库 ${mapped.length} 条`],
  };
  setSetting(`browser_scan_${platform}`, JSON.stringify(summary));
  return { code: 200, body: { ok: true, ...summary } };
}

async function runExtensionScan(b) {
  const platform = b.platform || 'zhipin';
  if (platform === 'zhipin') return runZhipinScan(b);
  if (platform === 'xhs') return runXhsScan(b);
  return { code: 400, body: { error: '该平台扫描适配中' } };
}

async function runZhipinScan(b) {
  const platform = b.platform || 'zhipin';
  const cfg = platformById(platform);
  if (!cfg) return { code: 400, body: { error: '未知平台' } };
  if (!cfg.scan) return { code: 400, body: { error: `${cfg.name} 的扫描适配中，目前只有 BOSS直聘 可用` } };
  const st = browserStatus(platform);
  if (st.browserOpen) return { code: 409, body: { error: '登录窗口还开着。先点「保存登录并扫描」，或关掉窗口再扫描' } };
  if (!st.loggedIn) return { code: 401, body: { error: '没检测到登录态。请先打开登录窗口完成登录' } };
  if (pendingExt) return { code: 409, body: { error: '已有一次扫描在进行中' } };

  const dir = loadSearchConfig();
  const keywords = [...new Set(dir.keywords)].slice(0, 5);
  const city = CITIES.find(c => c.name === dir.city)?.id || String(b.city || '101290100');
  const cityName = CITIES.find(c => c.id === city)?.name || dir.city || '昆明';
  const pages = Math.max(1, Math.min(3, Number(b.pages) || 1));
  const scanId = randomUUID();
  const urls = keywords.flatMap(kw => Array.from({ length: pages }, (_, i) =>
    `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(kw)}&city=${city}&page=${i + 1}&_radar_scan=${scanId}`)).slice(0, 6);

  pendingExt = { id: scanId, urls, at: Date.now(), jobs: [], resolve: null, timer: null };
  const done = new Promise(resolve => { pendingExt.resolve = resolve; });

  try {
    await openScanWindow(platform, join(ROOT, 'extension'), urls[0]);
  } catch (e) {
    pendingExt = null;
    return { code: 500, body: { error: e.message } };
  }

  const result = await Promise.race([
    done,
    sleep(45000).then(() => ({ timeout: true })),
  ]);
  clearTimeout(pendingExt?.timer);
  await closeLogin(platform);
  pendingExt = null;

  if (result.timeout) {
    const summary = { at: new Date().toISOString(), query: keywords.join(' / '), keywords, city: cityName, pages, error: 'TIMEOUT', log: [] };
    setSetting(`browser_scan_${platform}`, JSON.stringify(summary));
    return { code: 504, body: { error: '45 秒内没收到扩展回传的数据（可能被安全校验，或页面结构变了）' } };
  }
  if (!result.jobs.length) {
    const summary = { at: new Date().toISOString(), query: keywords.join(' / '), keywords, city: cityName, pages, error: 'EMPTY', log: [] };
    setSetting(`browser_scan_${platform}`, JSON.stringify(summary));
    return { code: 422, body: { error: '扩展回传了 0 条岗位：可能未登录、被安全校验，或 BOSS 改了卡片结构' } };
  }

  const seenRaw = new Set();
  const uniqueRaw = result.jobs.filter(r => {
    const key = r.url || `${r.title}|${r.company}`;
    if (seenRaw.has(key)) return false;
    seenRaw.add(key);
    return true;
  });
  const jobs = [];
  for (const r of uniqueRaw) {
    try { jobs.push(mapDomJob(r, cityName)); } catch { /* skip bad row */ }
  }
  const terms = keywords;
  const kept = jobs
    .map(j => ({ ...j, relevance: scoreRelevance(j.title, j.tags, j.summary, terms).score, channel: j.remote ? 'remote' : 'local' }))
    .filter(j => j.relevance >= 15);
  const r = saveJobs(kept);
  recomputeMatches();
  const summary = {
    at: new Date().toISOString(), query: keywords.join(' / '), keywords, city: cityName, pages,
    fetched: jobs.length, kept: kept.length, added: r.added,
    log: [`扩展回传 ${result.jobs.length} 条`, `去重后 ${jobs.length} 条`, `入库 ${kept.length} 条`],
  };
  setSetting(`browser_scan_${platform}`, JSON.stringify(summary));
  return { code: 200, body: { ok: true, ...summary } };
}

      if (path === '/api/extension/log' && req.method === 'POST') {
        try { const b = await body(req); console.log('EXT_LOG', b.who, String(b.msg).slice(0, 200)); } catch { /* ignore */ }
        return json(res, 200, { ok: true });
      }

      if (path === '/api/extension/jd' && req.method === 'POST') {
        const b = await body(req);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/extension/config' && req.method === 'GET') {
        if (pendingExt && Date.now() - pendingExt.at < 120000) {
          return json(res, 200, { scanId: pendingExt.id, urls: pendingExt.urls });
        }
        return json(res, 200, { idle: true });
      }

      if (path === '/api/extension/ingest' && req.method === 'POST') {
        const b = await body(req);
        console.log('EXT_INGEST_REQ', b.scanId, pendingExt && pendingExt.id, Array.isArray(b.jobs) ? b.jobs.length : -1);
        if (!pendingExt || b.scanId !== pendingExt.id) return json(res, 202, { ok: false });
        console.log('EXT_INGEST_OK', pendingExt.id);
        const rows = Array.isArray(b.jobs) ? b.jobs : [];
        console.log('EXT_INGEST', b.scanId, rows.length, (b.url || '').slice(0, 80));
        if (rows.length) { try { writeFileSync(join(ROOT, 'data', 'browser', 'last-rows.json'), JSON.stringify(rows, null, 1)); } catch { /* ignore */ } }
        if (b.html) {
          try { writeFileSync(join(ROOT, 'data', 'browser', rows.length ? 'last-scan-ok.html' : 'last-scan.html'), b.html); } catch { /* ignore */ }
        }
        pendingExt.jobs.push(...rows);
        if (pendingExt.timer) clearTimeout(pendingExt.timer);
        pendingExt.timer = setTimeout(() => pendingExt?.resolve({ jobs: pendingExt.jobs }), 6000);
        return json(res, 200, { ok: true, count: rows.length });
      }

      if (path === '/api/browser/extension-scan' && req.method === 'POST') {
        const b = await body(req);
        const r = await runExtensionScan(b);
        return json(res, r.code, r.body);
      }

      if (path === '/api/browser/scan' && req.method === 'POST') {
        const b = await body(req);
        const r = await runExtensionScan(b);
        return json(res, r.code, r.body);
      }

      if (path === '/api/browser/close-and-scan' && req.method === 'POST') {
        const b = await body(req);
        const platform = b.platform || 'zhipin';
        await closeLogin(platform);
        const r = await runExtensionScan({ ...b, platform });
        return json(res, r.code, r.body);
      }

      const transMatch = path.match(/^\/api\/jobs\/(.+)\/translate$/);
      if (transMatch && req.method === 'POST') {
        const job = getJob(transMatch[1]);
        if (!job) return json(res, 404, { error: 'not found' });
        if (!job.summary || job.summary.length < 20) return json(res, 400, { error: '该岗位没有可翻译的 JD' });
        try {
          const titleZh = /[a-z]/i.test(job.title || '') ? await translateText(job.title) : job.title;
          const summaryZh = await translateText((job.summary || '').slice(0, 3000));
          saveTranslation(job.id, titleZh, summaryZh);
          return json(res, 200, { title_zh: titleZh, summary_zh: summaryZh });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }

      if (path === '/api/keyword-categories') {
        return json(res, 200, keywordCategories());
      }

      if (path === '/api/search-config' && req.method === 'GET') {
        let lastScanConfig = null;
        try { lastScanConfig = JSON.parse(getSetting('last_scan_config') || 'null'); } catch { /* ignore */ }
        return json(res, 200, { ...loadSearchConfig(), lastScanConfig });
      }
      if (path === '/api/search-config' && req.method === 'POST') {
        const b = await body(req);
        const keywords = parseTerms(Array.isArray(b.keywords) ? b.keywords.join(',') : (b.keywords ?? b.query ?? ''));
        if (!keywords.length) return json(res, 400, { error: '至少一个关键词' });
        const cfg = {
          keywords,
          city: String(b.city || '昆明').trim().slice(0, 20) || '昆明',
          overseas: b.overseas !== false,
          updatedAt: new Date().toISOString(),
        };
        setSetting('search_config', JSON.stringify(cfg));
        return json(res, 200, cfg);
      }

      if (path === '/api/email/config' && req.method === 'GET') {
        return json(res, 200, maskEmail(readEmailConfig()));
      }
      if (path === '/api/email/config' && req.method === 'POST') {
        const b = await body(req);
        const old = readEmailConfig() || {};
        const next = {
          host: String(b.host || '').trim(),
          port: Math.min(65535, Math.max(1, Number(b.port) || 465)),
          secure: b.secure !== false,
          user: String(b.user || '').trim(),
          pass: b.pass ? String(b.pass) : old.pass,
          fromName: String(b.fromName || '').trim(),
          fromEmail: String(b.fromEmail || b.user || '').trim(),
        };
        if (!next.host || !next.user || !next.pass) return json(res, 400, { error: 'host / user / 授权码都需要' });
        writeFileSync(EMAIL_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
        return json(res, 200, maskEmail(next));
      }
      if (path === '/api/email/test' && req.method === 'POST') {
        const cfg = readEmailConfig();
        if (!cfg) return json(res, 400, { error: '邮箱未配置' });
        try { await verifyMailbox(cfg); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 500, { error: e.message }); }
      }

      const mailMatch = path.match(/^\/api\/jobs\/(.+)\/apply-email$/);
      if (mailMatch && req.method === 'POST') {
        const job = getJob(mailMatch[1]);
        if (!job) return json(res, 404, { error: 'not found' });
        const cfg = readEmailConfig();
        if (!cfg?.host) return json(res, 400, { error: '先在设置里配置投递邮箱' });
        const payload = await body(req);
        const to = String(payload.to || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(res, 400, { error: '收件邮箱格式不对' });
        const resumeName = payload.resume_name || '';
        const resume = resumePath(resumeName);
        if (!resume) return json(res, 400, { error: '选中的简历文件不存在' });
        const cover = payload.cover_letter || coverLetter(job);
        try {
          await sendMail(cfg, {
            to,
            subject: `应聘 ${job.title}${job.company ? ' - ' + job.company : ''}｜${PROFILE.name}`,
            text: cover,
            attachmentPath: resume,
          });
          saveApplication({
            job_id: job.id, status: 'applied', note: payload.note || `邮件投递至 ${to}`,
            cover_letter: cover, resume_name: resumeName,
          });
          return json(res, 200, { ok: true, to });
        } catch (e) {
          return json(res, 500, { error: '发信失败：' + e.message });
        }
      }

      if (path === '/api/profile' && req.method === 'GET') {
        let example = null;
        try { example = JSON.parse(readFileSync(join(ROOT, 'config', 'profile.example.json'), 'utf8')); } catch { /* ignore */ }
        return json(res, 200, { profile: PROFILE, example });
      }
      if (path === '/api/profile' && req.method === 'POST') {
        const b = await body(req);
        const p = b.profile;
        if (!p || typeof p !== 'object' || Array.isArray(p)) return json(res, 400, { error: 'profile 必须是对象' });
        if (!p.name || !p.skills || typeof p.skills !== 'object') return json(res, 400, { error: '至少需要 name 和 skills' });
        if (JSON.stringify(p).length > 200_000) return json(res, 413, { error: 'profile 太大（上限 200KB）' });
        writeFileSync(join(ROOT, 'data', 'profile.json'), JSON.stringify(p, null, 2), { mode: 0o600 });
        reloadProfile();
        recomputeMatches();
        return json(res, 200, { ok: true, profile: PROFILE });
      }

      if (path === '/api/platforms') {
        const jobs = allJobs();
        const bySource = new Map();
        for (const j of jobs) {
          const s = bySource.get(j.source) || { source: j.source, total: 0, direct: 0, postOnly: 0, missing: 0 };
          s.total++;
          if (j.original_url) s.direct++;
          else if (['eleduck', 'yuancheng'].includes(j.source)) s.postOnly++;
          else if (j.source === 'jobui') s.missing++;
          bySource.set(j.source, s);
        }
        const hosts = {};
        for (const j of jobs) {
          if (!j.original_url) continue;
          try {
            const h = new URL(j.original_url).hostname.replace(/^www\./, '');
            hosts[h] = (hosts[h] || 0) + 1;
          } catch { /* ignore */ }
        }
        return json(res, 200, {
          sources: [...bySource.values()].sort((a, b) => b.total - a.total),
          hosts,
          missing: countMissingOriginalUrl(),
        });
      }

      if (path === '/api/enrich' && req.method === 'POST') {
        const pend = jobsMissingOriginalUrl(6);
        let filled = 0;
        for (const j of pend) {
          const u = await enrichOriginalUrl(j);
          if (u) { setOriginalUrl(j.id, u); filled++; }
          await sleep(2200 + Math.random() * 1200);
        }
        return json(res, 200, { checked: pend.length, filled, remaining: countMissingOriginalUrl() });
      }

      if (path === '/api/recommendations') {
        const hours = Math.max(20, Math.min(80, Number(url.searchParams.get('hours')) || 50));
        const keywords = loadSearchConfig().keywords;
        const jobs = allJobs().filter(j => scoreRelevance(j.title, safeTags(j.tags), j.summary, keywords).score >= 15);
        return json(res, 200, { ...buildRecommendations(jobs, { hours }), directionKeywords: keywords });
      }

      if (path === '/api/scans') {
        const rows = db.prepare('SELECT id,started_at,finished_at,status,stats FROM scans ORDER BY id DESC LIMIT 10').all();
        return json(res, 200, rows.map(r => ({ ...r, stats: r.stats ? JSON.parse(r.stats) : null })));
      }

      if (path === '/api/scan' && req.method === 'POST') {
        if (scan.running) return json(res, 409, { started: false, reason: 'already-running' });
        doScan().catch(e => console.error('scan error', e));
        return json(res, 202, { started: true });
      }

      if (path === '/api/scan/status') {
        return json(res, 200, {
          running: scan.running, startedAt: scan.startedAt, log: scan.log.slice(-80),
          lastError: scan.lastError, lastScanAt: lastScanAt(),
          cooldownUntil: getSetting('jobui_cooldown_until'),
        });
      }

      if (path === '/api/applications' && req.method === 'GET') return json(res, 200, listApplications());
      if (path === '/api/applications' && req.method === 'POST') {
        const b = await body(req);
        if (!b.job_id) return json(res, 400, { error: 'job_id required' });
        if (!getJob(b.job_id)) return json(res, 404, { error: '岗位不存在' });
        const status = b.status || 'todo';
        if (!['todo', 'applied', 'interview', 'offer', 'rejected'].includes(status)) return json(res, 400, { error: 'status 不合法' });
        if (String(b.cover_letter || '').length > 30000) return json(res, 413, { error: '求职信太长' });
        return json(res, 200, saveApplication({ ...b, status }));
      }
      const appMatch = path.match(/^\/api\/applications\/(.+)$/);
      if (appMatch && req.method === 'DELETE') {
        deleteApplication(appMatch[1]);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/resumes') {
        const list = await listResumes();
        return json(res, 200, list.map(r => ({ ...r, tailored: r.dir.includes('tailored') })));
      }

      if (path === '/api/resume') {
        const name = url.searchParams.get('name') || '';
        const p = resumePath(name);
        if (!p) return json(res, 404, { error: 'resume not found' });
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${encodeURIComponent(basename(p))}"`,
        });
        return createReadStream(p).pipe(res);
      }

      if (path === '/api/cover-letter') {
        const job = getJob(url.searchParams.get('job_id'));
        if (!job) return json(res, 404, { error: 'not found' });
        return json(res, 200, { text: coverLetter(job) });
      }

      if (path === '/api/export') {
        const all = queryJobs({ channel: 'all', limit: 5000, offset: 0, sort: 'date' }).rows;
        if (url.searchParams.get('format') === 'csv') {
          const cols = ['company', 'title', 'salary_raw', 'location', 'remote', 'source', 'posted_at', 'url', 'original_url'];
          const esc = (v) => {
            let x = String(v ?? '');
            if (/^[=+\-@]/.test(x)) x = "'" + x; // 防 CSV 公式注入
            return `"${x.replace(/"/g, '""')}"`;
          };
          const csv = '\uFEFF' + [cols.join(','), ...all.map(j => cols.map(c => esc(c === 'remote' ? (j.remote ? '是' : '否') : j[c])).join(','))].join('\n');
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="jobs.csv"' });
          return res.end(csv);
        }
        return json(res, 200, all);
      }

      return json(res, 404, { error: 'unknown api' });
    }

    // ---- 静态文件 ----
    let file = path === '/' ? '/index.html' : path;
    file = normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = join(PUBLIC, file);
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    const s = await stat(full).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    return createReadStream(full).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Job Radar → http://127.0.0.1:${PORT}`);
  // 首次启动且库为空时自动扫一轮
  try { recomputeMatches(); } catch (e) { console.error('match backfill failed', e); }
  enrichNcssJobs().catch(() => {});
  const n = db.prepare('SELECT COUNT(*) c FROM jobs').get().c;
  if (n === 0) {
    console.log('数据库为空，启动首轮扫描…');
    setTimeout(() => doScan().catch(e => console.error(e)), 1500);
  }
});

// 定时扫描（默认 6 小时；可用环境变量覆盖）
const INTERVAL_H = Number(process.env.SCAN_INTERVAL_HOURS || 6);
setInterval(() => {
  if (scan.running) return;
  const last = lastScanAt();
  const due = !last || (Date.now() - new Date(last).getTime()) > INTERVAL_H * 3600e3;
  if (due) doScan().catch(e => console.error(e));
}, 5 * 60e3);
