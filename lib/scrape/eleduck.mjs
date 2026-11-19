import { get, sleep } from './jobui.mjs';
import { decodeEntities, htmlToText, parseSalary, parseDate, scoreRelevance, extractCompany, uniq } from '../parse.mjs';

// 从 HTML 中提取嵌套 JSON 对象（eleduck 把帖子数据内联在页面里）
export function extractJsonObjects(html) {
  const out = [];
  let i = 0;
  while (true) {
    i = html.indexOf('{"id":"', i);
    if (i < 0) break;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < html.length; j++) {
      const c = html[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) break; }
    }
    try { out.push(JSON.parse(html.slice(i, j + 1))); } catch { /* skip */ }
    i = j + 1;
  }
  return out;
}

function companyFromTitle(title) {
  const m = title.match(/^【[^】]*】\s*([^\s|｜，,]{2,16}?)\s*(?:招募|招聘)/)
    || title.match(/^([^\s|｜，,]{2,16}?)\s*(?:招募|招聘)/);
  const name = m?.[1] || null;
  return name && !/^(招聘|招募|急招|诚聘|高薪)/.test(name) ? name : null;
}

const stripMd = (s = '') => s
  .replace(/\*\*|__/g, '')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/#{1,6}\s?/g, '')
  .trim();

export function parseEleduck(html) {
  const objs = extractJsonObjects(html).filter(o => o.full_title && o.published_at);
  const seen = new Set();
  const jobs = [];
  for (const o of objs) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const rawTitle = o.full_title || o.title || '';
    const tags = (o.tags || []).map(t => t.name).filter(Boolean);
    const tagCodes = (o.tags || []).map(t => t.tag_group?.code);
    const city = (o.tags || []).find(t => t.tag_group?.code === 'city')?.name || null;
    const summary = stripMd(decodeEntities(o.summary || o.content || '')).slice(0, 3000);
    const remoteTags = tags.filter(t => /远程|线上|混合|居家/.test(t));
    const remote = remoteTags.length > 0 || /远程|线上|居家|SOHO|任意地点|不限地点|全球/i.test(rawTitle);
    const salaryText = (rawTitle + ' ' + summary.slice(0, 300)).match(/[$¥]?\s*\d+(?:\.\d+)?\s*[kK千万]?\s*[-~—至到]\s*[$¥]?\s*\d+(?:\.\d+)?\s*[kK千万]?\s*(?:\/\s*[月时天年]|元|\$)?/);
    const salary = parseSalary(salaryText?.[0] || null, { context: rawTitle + ' ' + summary.slice(0, 120) });
    const jobTag = tags.some(t => ['全职远程', '线上兼职', '混合办公', '全职坐班', '员工内推', '企业直招'].includes(t));
    if (!jobTag) continue;
    if (tags.includes('外包零活') || tags.includes('组队合伙')) continue;
    const rel = scoreRelevance(rawTitle, tags, summary);
    jobs.push({
      id: `eleduck:${o.id}`,
      source: 'eleduck',
      source_id: o.id,
      company: extractCompany(summary) || companyFromTitle(rawTitle) || null,
      title: rawTitle,
      salary_raw: salaryText?.[0]?.trim() || null,
      salary_min: salary.min,
      salary_max: salary.max,
      salary_currency: salary.currency,
      salary_period: salary.period,
      location: city || (remote ? '远程' : '不限'),
      city,
      remote,
      remote_note: remote ? (remoteTags.length ? '电鸭标签：' + remoteTags.join('/') : '标题标注远程') : null,
      tags: uniq(tags).slice(0, 8),
      summary: summary.slice(0, 1200),
      company_meta: null,
      url: `https://eleduck.com/posts/${o.id}`,
      original_url: null,
      posted_at: parseDate(o.published_at),
      relevance: rel.score,
      raw: { hits: rel.hits, tagCodes, recruiter: o.user?.nickname ?? null },
    });
  }
  return jobs;
}

export async function scrapeEleduck({ pages = 2, delay = [1200, 2000], onLog = () => {} } = {}) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const url = p === 1 ? 'https://eleduck.com/' : `https://eleduck.com/?page=${p}`;
    onLog(`电鸭第 ${p} 页`);
    const { text } = await get(url);
    const jobs = parseEleduck(text);
    all.push(...jobs);
    if (!jobs.length) break;
    await sleep(delay[0] + Math.random() * (delay[1] - delay[0]));
  }
  return all;
}
