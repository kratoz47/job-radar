import { parseSalary, detectRemoteCN, scoreRelevance, fixMojibake, parseTerms } from '../parse.mjs';

const API = 'https://www.chinahr.com/newchr/open/job/search';
const KEYWORDS = ['AI', '人工智能', '大模型', '智能体', '算法', 'Python', '数据分析', '昆明 AI'];

export async function scrapeChinahr({ onLog = () => {}, terms = [], city = '昆明' } = {}) {
  onLog('中华英才网 API');
  const jobs = [];
  const kws = terms.length ? terms.slice(0, 8) : KEYWORDS;
  for (const kw of kws) {
    let data;
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          Origin: 'https://www.chinahr.com',
          Referer: 'https://www.chinahr.com/job',
        },
        body: JSON.stringify({ page: 0, pageSize: 10, localId: '1', keyWord: kw }),
        signal: AbortSignal.timeout(20000),
      });
      data = await res.json();
    } catch (e) {
      onLog(`中华英才 ${kw} 失败: ${e.message}`);
      continue;
    }
    const items = (data && data.data && data.data.jobItems) || [];
    onLog(`中华英才 ${kw}: ${items.length} 条`);
    for (const it of items) {
      const place = fixMojibake(it.workPlace || '');
      const placeOk = !city || city === '全国' || place.includes(city) || (city === '昆明' && /云南/.test(place));
      if (!placeOk) continue;
      const title = fixMojibake(it.jobName || '');
      const tags = [it.workType, it.degree !== '无' ? it.degree : '', it.workExp !== '不限' ? it.workExp : '', it.industry, it.comSize].filter(Boolean);
      const summary = [it.workExp, it.degree !== '无' ? it.degree : null, it.recruitNumber, it.industry].filter(Boolean).join(' · ');
      const salary = parseSalary(it.salary || '');
      const rel = scoreRelevance(title, tags, summary, terms);
      jobs.push({
        id: `chinahr:${it.jobId}`,
        source: 'chinahr',
        source_id: String(it.jobId),
        company: fixMojibake(it.comName || '') || null,
        title,
        salary_raw: it.salary || null,
        salary_min: salary.min,
        salary_max: salary.max,
        salary_currency: salary.currency,
        salary_period: salary.period,
        location: place,
        city: /昆明/.test(place) ? '昆明' : '云南',
        remote: detectRemoteCN(title, tags.join(' ')),
        remote_note: null,
        tags: tags.slice(0, 6),
        summary,
        company_meta: [it.industry, it.comSize].filter(Boolean).join(' · ') || null,
        url: `https://www.chinahr.com/detail/${it.jobId}`,
        original_url: `https://www.chinahr.com/detail/${it.jobId}`,
        posted_at: null,
        relevance: rel.score,
        raw: { hits: rel.hits, keyword: kw },
      });
    }
  }
  const seen = new Set();
  return jobs.filter(j => (seen.has(j.id) ? false : (seen.add(j.id), true)));
}
