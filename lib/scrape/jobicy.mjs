import { get } from './jobui.mjs';
import { htmlToText, parseSalary, parseDate, scoreRelevance, fixMojibake, matchesTerms } from '../parse.mjs';

const AI_RE = /(\bai\b|artificial intelligence|machine learning|\bml\b|\bllm\b|\bagent\b|generative|genai|forward deployed|solutions? engineer|implementation|prompt|rag\b)/i;

export async function scrapeJobicy({ onLog = () => {}, terms = [] } = {}) {
  onLog('Jobicy API');
  const { text } = await get('https://jobicy.com/api/v2/remote-jobs?count=50&geo=anywhere', {
    timeout: 30000,
    headers: { Accept: 'application/json' },
  });
  const data = JSON.parse(text);
  const jobs = [];
  for (const j of data.jobs || []) {
    const title = fixMojibake(j.jobTitle || '');
    const industry = j.jobIndustry || '';
    if (terms.length && !matchesTerms(title + ' ' + industry, terms)) continue;
    if (!terms.length && !AI_RE.test(title) && !AI_RE.test(industry)) continue;
    const desc = htmlToText(j.jobDescription || j.jobExcerpt || '');
    const hasSalary = j.salaryMin || j.salaryMax;
    const cur = j.salaryCurrency || 'USD';
    const period = j.salaryPeriod === 'yearly' ? 'year' : j.salaryPeriod || 'year';
    const salRaw = hasSalary
      ? `${cur === 'USD' ? '$' : cur + ' '}${j.salaryMin || ''}${j.salaryMax ? '-' + j.salaryMax : ''}/${period === 'year' ? '年' : period}`
      : null;
    const salary = parseSalary(salRaw, { defaultCurrency: cur, context: period === 'year' ? 'year' : '' });
    const rel = scoreRelevance(title, [industry], desc, terms);
    jobs.push({
      id: `jobicy:${j.id}`,
      source: 'jobicy',
      source_id: String(j.id),
      company: fixMojibake(j.companyName || '') || null,
      title,
      salary_raw: salRaw,
      salary_min: salary.min,
      salary_max: salary.max,
      salary_currency: cur === 'USD' ? 'USD' : salary.currency,
      salary_period: salary.period,
      location: j.jobGeo || 'Anywhere',
      city: null,
      remote: true,
      remote_note: 'Jobicy 远程岗',
      tags: [j.jobIndustry, j.jobType, j.jobLevel].filter(Boolean).slice(0, 6),
      summary: desc.slice(0, 1200),
      company_meta: [j.jobType, j.jobLevel].filter(Boolean).join(' · ') || null,
      url: j.url,
      original_url: j.url,
      posted_at: parseDate(j.pubDate),
      relevance: rel.score,
      raw: { hits: rel.hits },
    });
  }
  return jobs;
}
