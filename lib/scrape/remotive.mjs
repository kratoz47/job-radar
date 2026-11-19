import { get } from './jobui.mjs';
import { htmlToText, parseSalary, parseDate, scoreRelevance, fixMojibake, matchesTerms } from '../parse.mjs';

const AI_RE = /(\bai\b|machine learning|\bml\b|\bllm\b|\bagent\b|generative|genai|forward deployed|solutions? engineer|implementation|deploy|prompt|rag\b)/i;

export async function scrapeRemotive({ onLog = () => {}, terms = [] } = {}) {
  onLog('Remotive API');
  const jobs = [];
  const queries = terms.length ? terms.slice(0, 3) : ['artificial intelligence', 'machine learning', 'llm'];
  for (const q of queries) {
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=60`;
    let data;
    try {
      const { text } = await get(url, { timeout: 30000, headers: { Accept: 'application/json' } });
      data = JSON.parse(text);
    } catch (e) { onLog(`Remotive ${q} 失败: ${e.message}`); continue; }
    for (const j of data.jobs || []) {
      const desc = htmlToText(j.description || '');
      if (terms.length && !matchesTerms(j.title + ' ' + (j.tags || []).join(' '), terms)) continue;
      if (!terms.length && !AI_RE.test(j.title) && !(j.tags || []).some(t => AI_RE.test(t))) continue;
      const salary = parseSalary(j.salary || null, { defaultCurrency: 'USD' });
      const rel = scoreRelevance(j.title, j.tags || [], desc, terms);
      jobs.push({
        id: `remotive:${j.id}`,
        source: 'remotive',
        source_id: String(j.id),
        company: fixMojibake(j.company_name || '') || null,
        title: fixMojibake(j.title),
        salary_raw: j.salary || null,
        salary_min: salary.min,
        salary_max: salary.max,
        salary_currency: salary.currency === 'CNY' ? 'USD' : salary.currency,
        salary_period: salary.period,
        location: j.candidate_required_location || 'Remote',
        city: null,
        remote: true,
        remote_note: 'Remotive 远程岗 · 地区限制见原站',
        tags: (j.tags || []).slice(0, 8),
        summary: fixMojibake(desc).slice(0, 1200),
        company_meta: null,
        url: j.url,
        original_url: j.url,
        posted_at: parseDate(j.publication_date),
        relevance: rel.score,
        raw: { hits: rel.hits },
      });
    }
  }
  const seen = new Set();
  return jobs.filter(j => (seen.has(j.id) ? false : (seen.add(j.id), true)));
}
