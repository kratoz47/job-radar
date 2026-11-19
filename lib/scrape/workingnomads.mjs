import { get } from './jobui.mjs';
import { htmlToText, parseDate, scoreRelevance, fixMojibake, matchesTerms } from '../parse.mjs';

const AI_RE = /(\bai\b|artificial intelligence|machine learning|\bml\b|\bllm\b|\bagent\b|generative|genai|forward deployed|solutions? engineer|implementation|prompt|rag\b)/i;

export async function scrapeWorkingNomads({ onLog = () => {}, terms = [] } = {}) {
  onLog('Working Nomads API');
  const { text } = await get('https://www.workingnomads.com/api/exposed_jobs/', {
    timeout: 30000,
    headers: { Accept: 'application/json' },
  });
  const list = JSON.parse(text);
  const jobs = [];
  for (const j of list) {
    const title = fixMojibake(j.title || '');
    const cat = j.category_name || '';
    const tagText = String(j.tags || '');
    if (terms.length && !matchesTerms(`${title} ${cat} ${tagText}`, terms)) continue;
    if (!terms.length && !AI_RE.test(title) && !AI_RE.test(cat) && !AI_RE.test(tagText)) continue;
    const desc = htmlToText(j.description || '');
    const rel = scoreRelevance(title, tagText.split(/[,;]/).slice(0, 6), desc, terms);
    const url = j.url;
    jobs.push({
      id: `workingnomads:${url}`,
      source: 'workingnomads',
      source_id: url,
      company: fixMojibake(j.company_name || '') || null,
      title,
      salary_raw: null,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_period: null,
      location: j.location || 'Remote',
      city: null,
      remote: true,
      remote_note: 'Working Nomads 远程岗',
      tags: [cat, ...tagText.split(/[,;]/)].filter(Boolean).slice(0, 6),
      summary: desc.slice(0, 1200),
      company_meta: cat || null,
      url,
      original_url: url,
      posted_at: parseDate(j.pub_date),
      relevance: rel.score,
      raw: { hits: rel.hits },
    });
  }
  return jobs;
}
