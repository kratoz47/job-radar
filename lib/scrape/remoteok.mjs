import { get } from './jobui.mjs';
import { htmlToText, parseSalary, parseDate, scoreRelevance, fixMojibake, matchesTerms } from '../parse.mjs';

const AI_RE = /(\bai\b|artificial intelligence|machine learning|\bml\b|\bllm\b|\bagent\b|generative|genai|forward deployed|solutions? engineer|implementation|deploy|applied ai|rag\b|prompt)/i;

function relevant(position, tags, terms) {
  if (terms.length) return matchesTerms(position + ' ' + tags.join(' '), terms);
  return AI_RE.test(position) || tags.some(t => AI_RE.test(t));
}

export async function scrapeRemoteOK({ onLog = () => {}, terms = [] } = {}) {
  onLog('RemoteOK API');
  const { text } = await get('https://remoteok.com/api', { timeout: 30000, headers: { Accept: 'application/json' } });
  const data = JSON.parse(text);
  const jobs = [];
  for (const j of data) {
    if (!j.id || !j.position) continue;
    const desc = htmlToText(j.description || '');
    if (!relevant(j.position, j.tags || [], terms)) continue;
    const hasSalary = !!(j.salary_min || j.salary_max);
    const salRaw = hasSalary ? `$${j.salary_min || ''}${j.salary_max ? '-' + j.salary_max : ''}/年` : null;
    const salary = parseSalary(salRaw, { defaultCurrency: 'USD', context: 'year' });
    const rel = scoreRelevance(j.position, j.tags || [], desc, terms);
    jobs.push({
      id: `remoteok:${j.id}`,
      source: 'remoteok',
      source_id: String(j.id),
      company: fixMojibake(j.company || '') || null,
      title: fixMojibake(j.position),
      salary_raw: salRaw,
      salary_min: salary.min,
      salary_max: salary.max,
      salary_currency: 'USD',
      salary_period: 'year',
      location: j.location || 'Remote',
      city: null,
      remote: true,
      remote_note: 'RemoteOK 远程岗',
      tags: (j.tags || []).slice(0, 8),
      summary: fixMojibake(desc).slice(0, 1200),
      company_meta: null,
      url: j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
      original_url: j.apply_url || null,
      posted_at: parseDate(j.epoch || j.date),
      relevance: rel.score,
      raw: { hits: rel.hits },
    });
  }
  return jobs;
}
