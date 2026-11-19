import { get, sleep } from './jobui.mjs';
import { htmlToText, decodeEntities, parseSalary, parseDate, scoreRelevance, fixMojibake, uniq, matchesTerms } from '../parse.mjs';

const AI_RE = /(\bai\b|人工智能|大模型|llm|agent|智能体|机器学习|\bml\b|算法|prompt|rag|部署|落地)/i;

export function parseYuancheng(html, terms = []) {
  const jobs = [];
  const blocks = html.split(/<div class="job[ "]/).slice(1);
  for (const b of blocks) {
    const t = b.match(/class="job-title[^"]*"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!t) continue;
    const url = t[1];
    const idm = url.match(/\/(\d+)\.html/);
    if (!idm) continue;
    const title = fixMojibake(htmlToText(t[2])).trim();
    const company = fixMojibake(htmlToText((b.match(/class="job-company"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '')).trim() || null;
    const salaryRaw = htmlToText((b.match(/class="job-salary[^"]*">([\s\S]*?)<\/span>/) || [])[1] || '').trim() || null;
    const metas = [...b.matchAll(/class="job-meta-value[^"]*">([\s\S]*?)<\/span>/g)].map(m => htmlToText(m[1]).trim()).filter(Boolean);
    const tags = uniq([...b.matchAll(/class="job-tag"[^>]*>([\s\S]*?)<\/a>/g)].map(m => htmlToText(m[1]).trim()));
    const salary = parseSalary(salaryRaw, { context: (metas || []).join(' ') });
    const rel = scoreRelevance(title, tags, metas.join(' '), terms);
    if (terms.length && !matchesTerms(title + ' ' + tags.join(' '), terms)) continue;
    if (!terms.length && !AI_RE.test(title + ' ' + tags.join(' '))) continue;
    jobs.push({
      id: `yuancheng:${idm[1]}`,
      source: 'yuancheng',
      source_id: idm[1],
      company,
      title,
      salary_raw: salaryRaw,
      salary_min: salary.min,
      salary_max: salary.max,
      salary_currency: salary.currency,
      salary_period: salary.period,
      location: '远程',
      city: null,
      remote: true,
      remote_note: metas.filter(m => /远程|兼职|全职|坐班/.test(m)).join('·') || '远程工作',
      tags: tags.slice(0, 8),
      summary: metas.join(' · ') || null,
      jdLoaded: false,
      company_meta: null,
      url,
      original_url: null,
      posted_at: parseDate((b.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null),
      relevance: rel.score,
      raw: { hits: rel.hits },
    });
  }
  return jobs;
}

export async function enrichYuancheng(job) {
  try {
    const { text } = await get(job.url);
    const m = text.match(/<div class="typo">([\s\S]*?)<\/div>/);
    if (!m) return null;
    const jd = htmlToText(m[1]).replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);
    return jd || null;
  } catch { return null; }
}

export async function scrapeYuancheng({ pages = 3, delay = [1200, 2000], onLog = () => {}, terms = [] } = {}) {
  const all = [];
  // 远程.work 是 WordPress：?s=关键词 就是站内搜索
  for (const term of terms.slice(0, 2)) {
    const url = `https://yuancheng.work/?s=${encodeURIComponent(term)}&post_type=job`;
    onLog(`远程.work 搜索「${term}」`);
    try {
      const { text } = await get(url);
      const jobs = parseYuancheng(text, terms);
      onLog(`远程.work 搜索「${term}」: ${jobs.length} 条`);
      all.push(...jobs);
    } catch (e) {
      onLog(`远程.work 搜索「${term}」失败: ${e.message}`);
    }
    await sleep(delay[0] + Math.random() * (delay[1] - delay[0]));
  }

  if (!terms.length) {
    for (let p = 1; p <= pages; p++) {
      const url = p === 1 ? 'https://yuancheng.work/' : `https://yuancheng.work/page/${p}/`;
      onLog(`远程.work 第 ${p} 页`);
      const { text } = await get(url);
      const jobs = parseYuancheng(text, terms);
      all.push(...jobs);
      if (!jobs.length) break;
      await sleep(delay[0] + Math.random() * (delay[1] - delay[0]));
    }
  }

  const seen = new Set();
  return all.filter(j => (seen.has(j.id) ? false : (seen.add(j.id), true)));
}
