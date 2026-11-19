import { parseSalary, detectRemoteCN, scoreRelevance, fixMojibake } from '../parse.mjs';

export function mapXhsJob(raw, terms = [], city = '昆明') {
  const title = fixMojibake(raw.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const text = `${title} ${raw.author || ''}`;
  if (!/(招聘|招人|内推|岗位|求职|面试|offer|兼职|全职|找工作)/i.test(text)) return null;
  const rel = scoreRelevance(title, ['小红书笔记'], text, terms);
  if (terms.length ? rel.score < 10 : !/(AI|人工智能|大模型|智能体|agent|算法|机器学习)/i.test(text)) return null;
  const remote = detectRemoteCN(text);
  const hitCity = city === '全国' ? null
    : text.includes(city) || (city === '昆明' && /云南/.test(text)) ? city
      : /昆明/.test(text) ? '昆明' : /云南/.test(text) ? '云南' : null;
  if (city !== '全国' && !hitCity && !remote) return null;

  const salText = title.match(/\d+(?:\.\d+)?\s*[kK万]?\s*[-~—至到]\s*\d+(?:\.\d+)?\s*[kK万]?\s*(?:元\/?[月天时年]|元)?/)?.[0] || null;
  const salary = parseSalary(salText);
  const id = raw.noteId || (raw.url || '').match(/(?:search_result|explore)\/([^?/]+)/)?.[1] || Buffer.from(title).toString('base64url').slice(0, 20);
  const author = (fixMojibake(raw.author || '') || '').replace(/(\d+\s*(天前|小时前|分钟前)|\d{2}-\d{2})$/, '').trim() || null;

  return {
    id: `xhs:${id}`,
    source: 'xhs',
    source_id: String(id),
    company: author,
    title,
    salary_raw: salText,
    salary_min: salary.min,
    salary_max: salary.max,
    salary_currency: salary.currency,
    salary_period: salary.period,
    location: hitCity || '远程',
    city: hitCity,
    remote,
    remote_note: remote ? '笔记标题标注远程' : null,
    tags: ['小红书笔记', '招聘'],
    summary: `${title}\n\n作者：${author || '未署名'}${raw.likes ? ` · ${raw.likes} 赞` : ''}\n这是小红书招聘笔记；完整内容请打开原帖查看。`,
    company_meta: '小红书 · 笔记',
    cover_url: raw.cover || null,
    note_likes: raw.likes || null,
    url: raw.url || '',
    original_url: raw.url || null,
    posted_at: null,
    relevance: rel.score,
    raw: { hits: rel.hits, via: 'xhs-extension' },
  };
}
