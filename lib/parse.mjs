// 文本清洗、薪资归一化、远程判定、岗位相关性打分

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rarr: '→', larr: '←', ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•' };

export function decodeEntities(s = '') {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html = '') {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- 薪资 ----------
// 返回 { min, max, currency, period, raw }，period ∈ month|year|day|hour
const UNIT = { '万': 1e4, w: 1e4, k: 1e3, '千': 1e3 };

export function parseSalary(raw, { defaultCurrency = 'CNY', context = '' } = {}) {
  if (!raw) return { min: null, max: null, currency: defaultCurrency, period: 'month', raw: raw ?? null };
  let text = String(raw).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const full = text + ' ' + context;
  if (/面议|面谈|negotiable/i.test(text)) {
    return { min: null, max: null, currency: defaultCurrency, period: 'month', raw: text };
  }

  const currency = /[$]|USD|美元|美金/i.test(full) ? 'USD'
    : /€|EUR|欧元/i.test(full) ? 'EUR'
    : /£|GBP|英镑/i.test(full) ? 'GBP'
    : 'CNY';

  let period = 'month';
  if (/时薪|每小时|\/\s*(时|小时|h|hr)|per hour|hour/i.test(full)) period = 'hour';
  else if (/日薪|每天|\/\s*(天|日)|per day/i.test(full)) period = 'day';
  else if (/年薪|每年|\/\s*(年|yr|year)|per year/i.test(full)) period = 'year';

  // 去掉「13薪」这类干扰数字
  text = text.replace(/\d{2}\s*薪/g, ' ');

  const tokens = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(万|w|k|千)?/gi)];
  const norm = (u) => (u ? u.toLowerCase() : null);
  const val = (t) => parseFloat(t[1]) * (UNIT[norm(t[2])] || 1);

  let min = null, max = null;
  if (tokens.length >= 2) {
    const a = val(tokens[0]);
    const b = val(tokens[1]);
    const ua = norm(tokens[0][2]);
    const ub = norm(tokens[1][2]);
    // 一端有单位、另一端没有：单位套用到两端
    const av = ua || !ub ? a : a * (UNIT[ub] || 1);
    const bv = ub || !ua ? b : b * (UNIT[ua] || 1);
    if (av > 0 && bv > 0) { min = Math.min(av, bv); max = Math.max(av, bv); }
  } else if (tokens.length === 1) {
    min = val(tokens[0]); max = null;
  }

  // 年份误判（1990-2035 且无单位）剔除
  if (min != null && !tokens.some(t => t[2])) {
    if (min >= 1990 && min <= 2035) { min = null; max = null; }
    if (max != null && max >= 1990 && max <= 2035) max = null;
  }
  // 月薪低于 500 且无「/天」「/时」语境，视为异常
  if (min != null && period === 'month' && min < 500) { min = null; max = null; }
  if (min != null && max != null && max / min > 30) max = null;

  return { min, max, currency, period, raw: text };
}

export function formatSalary(j) {
  if (j.salary_min == null) return j.salary_raw || '面议';
  const cur = j.salary_currency === 'USD' ? '$' : j.salary_currency === 'EUR' ? '€' : j.salary_currency === 'GBP' ? '£' : '¥';
  const per = { month: '/月', year: '/年', day: '/天', hour: '/时' }[j.salary_period] || '';
  const n = (v) => (v >= 10000 ? `${(v / 10000).toFixed(v % 10000 === 0 ? 0 : 1)}万` : v >= 1000 ? `${Math.round(v / 100) / 10}k` : `${v}`);
  if (j.salary_max == null) return `${cur}${n(j.salary_min)}${per}`;
  return `${cur}${n(j.salary_min)}-${n(j.salary_max)}${per}`;
}

// ---------- 远程 ----------
const REMOTE_CN = /远程|居家|在家办公|线上办公|异地|不限地点|地点不限|全国|SOHO|数字游民/i;
const REMOTE_NO = /不接受远程|不支持远程|必须坐班|需坐班|到岗/;

export function detectRemoteCN(...texts) {
  const t = texts.filter(Boolean).join(' ');
  if (REMOTE_NO.test(t)) return false;
  return REMOTE_CN.test(t);
}

// ---------- 相关性 ----------
const STRONG = ['落地', '部署', '实施', '交付', '解决方案', 'fde', 'solution', '集成', '数字化', '咨询', '架构', '智能体', 'agent', '工作流', '自动化', 'forward deployed'];
const MEDIUM = ['ai应用', 'ai落地', 'ai产品', '大模型', 'llm', 'rag', 'prompt', '机器学习', '深度学习', '算法', 'python', 'api', '平台', '产品经理', 'ai工程师', 'ai开发', 'ai原生', '开发工程师', '应用开发', '应用'];
const WEAK = ['ai', '人工智能', '模型', '数据'];
const NOISE = ['主播', '剪辑', '动画', '编剧', '配音', '直播', '带货', '销售', '客服', '讲师', '标注', '数据采集', '审核', '运营', '助教', '督学', '兼职', '招生', '实习', '助理', '文员', '设计', '美术', '绘画', '文案', '策划', '摄影', '化妆', '翻译'];

export function parseTerms(input = '') {
  return [...new Set(String(input || '')
    .split(/[,，、;；\n]+/)
    .map(x => x.trim())
    .filter(Boolean))].slice(0, 10);
}

export function matchesTerms(text = '', terms = []) {
  if (!terms.length) return true;
  const t = String(text || '').toLowerCase().replace(/\s+/g, '');
  return terms.some(term => t.includes(String(term).toLowerCase().replace(/\s+/g, '')));
}

export function scoreRelevance(title = '', tags = [], summary = '', terms = []) {
  // 去掉空格再做中文/英文关键词匹配，避免「AI 开发工程师」漏掉「ai开发」
  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, '');
  if (terms && terms.length) {
    const t = norm(title);
    const tg = norm((tags || []).join(' '));
    const s = norm(summary);
    let score = 0;
    const hits = [];
    for (const term of terms) {
      const k = norm(term);
      if (!k) continue;
      if (t.includes(k)) { score += 35; hits.push(term); }
      else if (tg.includes(k)) { score += 15; hits.push(term); }
      else if (s.includes(k)) { score += 6; hits.push(term); }
    }
    return { score: Math.min(100, score), hits: hits.slice(0, 6) };
  }
  const t = norm(title);
  const tg = norm((tags || []).join(' '));
  const s = norm(summary);
  let score = 0;
  const hits = [];
  const count = (list, text) => list.reduce((n, k) => n + (text.includes(k) ? 1 : 0), 0);

  score += Math.min(60, count(STRONG, t) * 25 + count(STRONG, tg) * 12 + count(STRONG, s) * 6);
  score += Math.min(35, count(MEDIUM, t) * 12 + count(MEDIUM, tg) * 6 + count(MEDIUM, s) * 3);
  score += Math.min(15, count(WEAK, t) * 5 + count(WEAK, tg) * 3);
  for (const k of [...STRONG, ...MEDIUM]) if ((t + tg).includes(k) && !hits.includes(k)) hits.push(k);

  const noiseHits = count(NOISE, t);
  if (noiseHits && !count(STRONG, t)) score -= 45;
  else if (noiseHits) score -= 15;

  return { score: Math.max(0, Math.min(100, score)), hits: hits.slice(0, 6) };
}

export function fixMojibake(s = '') {
  return String(s)
    .replace(/â€“|â€”/g, '–')
    .replace(/â€™/g, "'")
    .replace(/â€œ|â€\x9d/g, '"')
    .replace(/Ã©/g, 'é')
    .replace(/Â /g, ' ');
}

export function parseDate(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  const d = new Date(String(v));
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return null;
}

export function extractCompany(text = '') {
  const m = text.match(/(?:公司|企业|单位)(?:名称|全称|简称)?[：:]\s*([^\s，,。;；\n]{2,30})/);
  return m ? m[1].trim() : null;
}

export function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}
