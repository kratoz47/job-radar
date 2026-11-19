import { scrapeJobui, enrichOriginalUrl, sleep } from './jobui.mjs';
import { scrapeEleduck } from './eleduck.mjs';
import { scrapeYuancheng, enrichYuancheng } from './yuancheng.mjs';
import { scrapeChinahr } from './chinahr.mjs';
import { scrapeRemoteOK } from './remoteok.mjs';
import { scrapeRemotive } from './remotive.mjs';
import { scrapeJobicy } from './jobicy.mjs';
import { scrapeWorkingNomads } from './workingnomads.mjs';
import { saveJobs, setOriginalUrl, pendingEnrichment, setSetting } from '../db.mjs';
import { parseSalary, scoreRelevance } from '../parse.mjs';
import { expandTerms } from '../terms.mjs';

// 自动扫描配置由「设置 → 搜索关键词」写入；默认仍偏 AI 落地岗
export const DEFAULT_SEARCH = { keywords: ['AI应用', '大模型', 'AI落地'], city: '昆明', overseas: true };

export async function runScan({ onLog = () => {}, skipJobui = false, config = {} } = {}) {
  const t0 = Date.now();
  const log = [];
  const add = (m) => { log.push(m); onLog(m); };

  const keywords = (Array.isArray(config.keywords) && config.keywords.length ? config.keywords : DEFAULT_SEARCH.keywords)
    .map(x => String(x).trim()).filter(Boolean).slice(0, 10);
  const city = String(config.city || DEFAULT_SEARCH.city).trim() || '昆明';
  const terms = keywords;
  const overseasTerms = expandTerms(keywords);

  const stats = { added: 0, updated: 0, jobui: 0, chinahr: 0, eleduck: 0, yuancheng: 0, remoteok: 0, remotive: 0, jobicy: 0, workingnomads: 0, dropped: 0, errors: [] };

  // 统一按用户关键词重算相关度；来源自己的 AI 过滤只作为兜底
  const annotate = (jobs) => jobs.map(j => {
    const r = scoreRelevance(j.title, j.tags, j.summary, terms);
    return { ...j, relevance: r.score };
  });

  // 1) 职友集：关键词 × 城市 + 全国（远端），控制在 4 个请求内
  let captcha = false;
  if (skipJobui) add('职友集处于冷却期，本轮跳过');
  const jobuiQueries = [];
  keywords.slice(0, 2).forEach((kw, idx) => {
    jobuiQueries.push({ kw, city, pages: idx === 0 ? 2 : 1 });
    if (idx === 0 && city !== '全国') jobuiQueries.push({ kw, city: '全国', pages: 1 });
  });
  for (const q of jobuiQueries) {
    if (captcha || skipJobui) break;
    try {
      const raw = await scrapeJobui({ keyword: q.kw, city: q.city, pages: q.pages, delay: [6000, 9000], onLog: add });
      const jobs = annotate(raw).map(j => ({ ...j, channel: channelOf(j) }));
      const kept = jobs.filter(j => keepJobui(j, q.city));
      stats.dropped += jobs.length - kept.length;
      const r = saveJobs(kept);
      stats.added += r.added; stats.updated += r.updated; stats.jobui += kept.length;
      add(`职友集 ${q.city}/${q.kw}: 抓到 ${jobs.length}，保留 ${kept.length}（新增 ${r.added}）`);
    } catch (e) {
      if (e.code === 'CAPTCHA') {
        captcha = true;
        stats.errors.push('职友集验证码');
        setSetting('jobui_cooldown_until', new Date(Date.now() + 3 * 3600e3).toISOString());
        add('职友集触发验证码，本次停止该源（冷却 3 小时）');
      } else {
        stats.errors.push(`职友集 ${q.city}/${q.kw}: ${e.message}`);
        add(`职友集 ${q.city}/${q.kw} 失败: ${e.message}`);
      }
    }
  }

  // 2) 中华英才（免登录 API）
  try {
    const raw = await scrapeChinahr({ onLog: add, terms, city });
    const jobs = annotate(raw).map(j => ({ ...j, channel: 'local' }));
    const kept = jobs.filter(j => j.relevance >= 12);
    const r = saveJobs(kept);
    stats.added += r.added; stats.updated += r.updated; stats.chinahr += kept.length; stats.dropped += jobs.length - kept.length;
    add(`中华英才: 抓到 ${jobs.length}，保留 ${kept.length}（新增 ${r.added}）`);
  } catch (e) {
    stats.errors.push(`中华英才: ${e.message}`);
    add(`中华英才失败: ${e.message}`);
  }

  // 3) 电鸭（中国远程）
  try {
    const raw = await scrapeEleduck({ pages: 3, onLog: add });
    const jobs = annotate(raw).map(j => ({ ...j, channel: 'remote' }));
    const kept = jobs.filter(j => j.relevance >= 15);
    const r = saveJobs(kept);
    stats.added += r.added; stats.updated += r.updated; stats.eleduck += kept.length; stats.dropped += jobs.length - kept.length;
    add(`电鸭: 抓到 ${jobs.length}，保留 ${kept.length}（新增 ${r.added}）`);
  } catch (e) {
    stats.errors.push(`电鸭: ${e.message}`);
    add(`电鸭失败: ${e.message}`);
  }

  // 4) 远程.work（中国远程）
  try {
    const raw = await scrapeYuancheng({ pages: 3, onLog: add, terms });
    const jobs = annotate(raw).map(j => ({ ...j, channel: 'remote' }));
    const kept = jobs.filter(j => j.relevance >= 15);
    for (const j of kept) {
      const jd = await enrichYuancheng(j);
      if (jd) {
        j.summary = jd;
        j.relevance = scoreRelevance(j.title, j.tags, j.summary, terms).score;
        if (j.salary_min == null) {
          const seg = jd.match(/(?:薪资|薪酬|待遇|工资)[^\n]{0,80}/)?.[0] || '';
          const sm = seg.match(/\d+(?:\.\d+)?\s*[kK万]?\s*[-~—至到]\s*\d+(?:\.\d+)?\s*[kK万]?/);
          if (sm) { const s2 = parseSalary(sm[0], { context: seg }); j.salary_raw = sm[0]; j.salary_min = s2.min; j.salary_max = s2.max; j.salary_currency = s2.currency; j.salary_period = s2.period; }
        }
      }
      await sleep(1200 + Math.random() * 800);
    }
    const kept2 = kept.filter(j => j.relevance >= 15);
    const r = saveJobs(kept2);
    stats.added += r.added; stats.updated += r.updated; stats.yuancheng += kept2.length; stats.dropped += jobs.length - kept2.length;
    add(`远程.work: 抓到 ${jobs.length}，保留 ${kept2.length}（新增 ${r.added}）`);
  } catch (e) {
    stats.errors.push(`远程.work: ${e.message}`);
    add(`远程.work 失败: ${e.message}`);
  }

  // 5) 海外远程
  if (config.overseas !== false) {
    for (const [name, fn, key] of [
      ['RemoteOK', scrapeRemoteOK, 'remoteok'],
      ['Remotive', scrapeRemotive, 'remotive'],
      ['Jobicy', scrapeJobicy, 'jobicy'],
      ['Working Nomads', scrapeWorkingNomads, 'workingnomads'],
    ]) {
      try {
        const raw = await fn({ onLog: add, terms: overseasTerms });
        const jobs = raw.map(j => {
          const r = scoreRelevance(j.title, j.tags, j.summary, overseasTerms);
          return { ...j, relevance: r.score, channel: 'overseas' };
        });
        const kept = jobs.filter(j => j.relevance >= 15);
        const r = saveJobs(kept);
        stats.added += r.added; stats.updated += r.updated; stats[key] += kept.length; stats.dropped += jobs.length - kept.length;
        add(`${name}: 抓到 ${jobs.length}，保留 ${kept.length}（新增 ${r.added}）`);
      } catch (e) {
        stats.errors.push(`${name}: ${e.message}`);
        add(`${name} 失败: ${e.message}`);
      }
    }
  } else {
    add('已关闭海外远程源');
  }

  // 6) 回填原站链接（每轮最多 12 条）
  if (!captcha) {
    const pend = pendingEnrichment(12, 40);
    let done = 0;
    for (const j of pend) {
      const u = await enrichOriginalUrl(j);
      if (u) { setOriginalUrl(j.id, u); done++; }
      await sleep(2000 + Math.random() * 800);
    }
    if (pend.length) add(`回填原站链接 ${done}/${pend.length}`);
  }

  stats.ms = Date.now() - t0;
  add(`完成，用时 ${(stats.ms / 1000).toFixed(1)}s`);
  return { stats, log };
}

function channelOf(j) {
  if (j.remote) return 'remote';
  return 'local';
}

function keepJobui(j, city) {
  if (city === '全国') return j.remote === true && j.relevance >= 15;
  return j.relevance >= 15;
}
