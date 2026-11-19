import { parseSalary, detectRemoteCN, scoreRelevance, fixMojibake } from '../parse.mjs';

export function mapDomJob(raw, cityName) {
  const title = fixMojibake(raw.title || '');
  const url = raw.url || '';
  const idm = url.match(/job_detail\/([^.?/]+)/);
  const id = idm ? idm[1] : Buffer.from(`${title}|${raw.company || ''}`).toString('base64url').slice(0, 24);
  const tags = [...new Set((raw.tags || []).filter(Boolean))].slice(0, 8);
  const info = fixMojibake(raw.info || '');
  const detail = (raw.detail || '').trim();
  const summary = detail
    ? `${detail}\n\n${info}`
    : [info, tags.join(' / ')].filter(Boolean).join(' · ');
  const salary = parseSalary(raw.salary || '');
  const area = fixMojibake(raw.area || '') || cityName;
  const remote = detectRemoteCN(title, tags.join(' '), area);
  const rel = scoreRelevance(title, tags, summary);
  return {
    id: `zhipin:${id}`,
    source: 'zhipin',
    source_id: String(id),
    company: fixMojibake(raw.company || '') || null,
    title,
    salary_raw: raw.salary || null,
    salary_min: salary.min,
    salary_max: salary.max,
    salary_currency: salary.currency,
    salary_period: salary.period,
    location: area,
    city: cityName,
    remote,
    remote_note: remote ? 'BOSS 标题/标签标注远程' : null,
    tags,
    summary,
    company_meta: null,
    url: url || `https://www.zhipin.com/`,
    original_url: url || null,
    posted_at: new Date().toISOString(),
    relevance: rel.score,
    raw: { hits: rel.hits, via: 'extension' },
  };
}
