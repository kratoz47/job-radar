import { decodeEntities, htmlToText, parseSalary, detectRemoteCN, scoreRelevance, parseDate } from '../parse.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function get(url, { timeout = 20000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...headers,
    },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  const text = await res.text();
  return { status: res.status, text, url: res.url };
}

export function isCaptcha(html) {
  return /验证码验证|安全验证|请输入验证码|访问过于频繁/.test(html?.slice(0, 4000) ?? '');
}

// 解析职友集搜索结果页
export function parseJobuiList(html, { city }) {
  const jobs = [];
  const chunks = html.split('<div class="c-job-list">').slice(1);
  for (const chunk of chunks) {
    const idm = chunk.match(/class="job-name"\s+href="\/job\/(\d+)\//);
    const tm = chunk.match(/class="job-name"[\s\S]*?<h3>([\s\S]*?)<\/h3>/);
    if (!idm || !tm) continue;
    const id = idm[1];
    const title = htmlToText(tm[1]).replace(/\s+/g, ' ').trim();
    const salaryRaw = (chunk.match(/class="job-pay-text">([\s\S]*?)<\/span>/) || [])[1]?.trim() || null;
    const companyM = chunk.match(/class="job-company-name"[^>]*>([\s\S]*?)<\/a>/);
    const company = companyM ? htmlToText(companyM[1]).trim() : null;
    const dateRaw = (chunk.match(/class="job-add-date">([\s\S]*?)<\/div>/) || [])[1]?.trim();
    const metaM = chunk.match(/([\d,]+人次浏览\s*\/\s*[^<]*)/);
    const metaText = metaM ? decodeEntities(metaM[1]).replace(/\s+/g, ' ').trim() : null;
    const desc = chunk.match(/<div class="job-desc">([\s\S]*?)<\/div>/);
    const descText = desc ? htmlToText(desc[1]).replace(/\s+/g, ' ').trim() : '';
    // 经验/学历/薪资三段
    const segs = [...descText.matchAll(/([^|]+?)(?:\s*\|\s*|$)/g)].map(m => m[1].trim()).filter(Boolean);
    const expEdu = segs.slice(0, 2).join(' · ');

    const salary = parseSalary(salaryRaw);
    const remote = detectRemoteCN(title);
    const rel = scoreRelevance(title, [], descText);
    const city_ = city || null;

    jobs.push({
      id: `jobui:${id}`,
      source: 'jobui',
      source_id: id,
      company,
      title,
      salary_raw: salaryRaw,
      salary_min: salary.min,
      salary_max: salary.max,
      salary_currency: salary.currency,
      salary_period: salary.period,
      location: city_ === '全国' ? '全国' : city_,
      city: city_,
      remote,
      remote_note: remote ? '标题标注远程/线上' : null,
      tags: expEdu ? [expEdu] : [],
      summary: [metaText, expEdu].filter(Boolean).join(' · ') || null,
      company_meta: metaText,
      url: `https://www.jobui.com/job/${id}/`,
      original_url: null,
      posted_at: dateRaw ? parseDate(dateRaw) : null,
      relevance: rel.score,
      raw: { hits: rel.hits },
    });
  }
  return jobs;
}

// 详情页里的隐藏字段带原站链接，例如 zhipin.com 的 job_detail
export async function enrichOriginalUrl(job) {
  try {
    const { text } = await get(job.url);
    const m = text.match(/data-url="([^"]+)"/);
    if (m && /^https?:\/\//.test(m[1])) return m[1];
  } catch { /* ignore */ }
  return null;
}

export async function scrapeJobui({ keyword, city, pages = 1, delay = [1600, 2600], onLog = () => {} }) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const url = `https://www.jobui.com/jobs?jobKw=${encodeURIComponent(keyword)}&cityKw=${encodeURIComponent(city)}&page=${p}`;
    onLog(`职友集 ${city}/${keyword} 第 ${p} 页`);
    const { text } = await get(url);
    if (isCaptcha(text)) {
      onLog(`职友集触发验证码，停止 ${city}/${keyword}`);
      const err = new Error('CAPTCHA');
      err.code = 'CAPTCHA';
      throw err;
    }
    const jobs = parseJobuiList(text, { city });
    all.push(...jobs);
    if (!jobs.length) break;
    await sleep(delay[0] + Math.random() * (delay[1] - delay[0]));
  }
  return all;
}
