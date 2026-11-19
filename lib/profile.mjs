// 简历画像 + 加权匹配 + 优化建议 + 定制简历 HTML
import { parseJD } from './jd.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_PROFILE = {
  name: '你的名字',
  title: 'AI 应用落地 / Forward Deployed / Agent 工作流',
  location: '昆明',
  remote: true,
  years: 3,
  education: '本科',
  english: 'CET-6 · 可读英文文档',
  contact: {
    phone: '138 0000 0000',
    email: 'you@example.com',
    site: 'your.site',
    github: 'github.com/yourname',
  },
  skills: {
    agent: { level: 2, evidence: '做过 2 条 Agent 工作流' },
    'llm-app': { level: 2, evidence: '接过 LLM API 做问答' },
    prompt: { level: 2, evidence: '写过可复用的 Prompt 模板' },
    api: { level: 2, evidence: '对接过 3 个第三方 API' },
    deploy: { level: 1, evidence: '用云主机部署过 demo' },
    python: { level: 1, evidence: '能写脚本' },
    'data-analysis': { level: 2, evidence: '做过业务数据看板' },
    requirements: { level: 3, evidence: '能把业务需求拆成流程' },
    project: { level: 2, evidence: '独立交付过项目' },
    rag: { level: 0, evidence: '没做过 RAG' },
    finetune: { level: 0, evidence: '不做模型训练' },
    container: { level: 0, evidence: '没用过 Docker' },
    frontend: { level: 0, evidence: '不会前端' },
  },
  keywords: ['Agent 工作流', 'Prompt', 'API 部署', '数据看板'],
  summary: [
    '现在：独立把一条业务流程做成能上线的 Agent 工作流。',
    '判断：AI 项目卡住，多半是流程没拆对、验收没定清。',
    '作品：一个上线产品、两条内部工作流。',
    '方向：FDE / AI 应用落地。',
  ],
  experiences: [{
    company: '公司 A',
    role: 'AI 应用工程师',
    period: '2022 – 2024',
    bullets: ['把客服问答做成 Agent 工作流，人工工单下降 40%。', '接通内部系统 API，交付可用的数据看板。'],
  }],
  projects: [{
    name: '项目 B（已上线）',
    period: '2024 – 至今',
    bullets: ['独立完成需求、Prompt、API 对接与部署。'],
  }],
  educationHistory: [{ school: '某某大学', major: '计算机', degree: '本科', period: '2015 – 2019' }],
  languages: ['中文（母语）', '英语 CET-6'],
  targets: ['AI Agent', 'FDE', 'AI 应用落地'],
  method: [
    ['01', '画流程、算人工：找值得交给 Agent 的环节'],
    ['02', '定验收：产出什么、谁验收、看 3 个指标'],
    ['03', '搭工作流：Prompt → 节点 → 人工兜底'],
    ['04', '接 API 上线：部署、监控、按结果迭代'],
  ],
};

const CONFIG_PATH = join(import.meta.dirname, '..', 'config', 'profile.json');
const DATA_PATH = join(import.meta.dirname, '..', 'data', 'profile.json');

function loadProfile() {
  for (const file of [DATA_PATH, CONFIG_PATH]) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      return { ...DEFAULT_PROFILE, ...raw, contact: { ...(DEFAULT_PROFILE.contact || {}), ...(raw.contact || {}) } };
    } catch { /* try next */ }
  }
  return DEFAULT_PROFILE;
}

export let PROFILE = loadProfile();

export function reloadProfile() {
  PROFILE = loadProfile();
  return PROFILE;
}


export function scoreItems(items) {
  const dims = DIMS.map(d => {
    const list = items.filter(i => dimOf(i) === d.key || (d.key === 'hard' && i.kind === 'hard'));
    const total = list.reduce((n, i) => n + i.weight, 0);
    const got = list.reduce((n, i) => n + i.weight * STATUS_VALUE[i.status], 0);
    return { ...d, score: total ? Math.round((got / total) * 100) : null, total };
  }).filter(d => d.score !== null && d.total >= 3);

  const wsum = dims.reduce((n, d) => n + d.weight, 0);
  const score = wsum ? Math.round(dims.reduce((n, d) => n + d.score * d.weight, 0) / wsum) : 0;
  return { dims, score };
}

const DIMS = [
  { key: 'ai', name: 'AI 能力', weight: 0.35 },
  { key: 'eng', name: '工程与部署', weight: 0.2 },
  { key: 'biz', name: '业务与交付', weight: 0.25 },
  { key: 'hard', name: '硬性条件', weight: 0.2 },
];

const dimOf = (s) => (s.dim === 'tool' ? 'eng' : s.dim);

const EDU_RANK = { 大专: 1, 本科: 2, 硕士: 3, 博士: 4 };
const STATUS_VALUE = { hit: 1, partial: 0.55, miss: 0 };
const STATUS_LABEL = { hit: '命中', partial: '部分', miss: '缺失' };

export function analyzeJob(job) {
  const jd = parseJD(job.summary || '', job);
  const items = [];

  for (const s of jd.skills) {
    const p = PROFILE.skills[s.id];
    const level = p?.level ?? 0;
    const status = level >= 2 ? 'hit' : level === 1 ? 'partial' : 'miss';
    items.push({
      kind: 'skill', dim: s.dim, id: s.id, label: s.name, weight: s.weight, status,
      mine: p?.evidence || '无直接证据', level, where: s.where,
    });
  }

  for (const h of jd.hard) {
    if (h.id === 'years') {
      const num = parseYearsNum(h.value);
      const status = !num ? 'hit' : PROFILE.years >= num[0] ? 'hit' : PROFILE.years >= num[0] - 2 ? 'partial' : 'miss';
      items.push({ kind: 'hard', dim: 'hard', id: 'years', label: `经验 ${h.value}`, weight: h.weight, status, mine: `${PROFILE.years} 年（2017 起）` });
    } else if (h.id === 'education') {
      const need = EDU_RANK[h.value] ?? 0;
      const mine = EDU_RANK[PROFILE.education] ?? 0;
      items.push({ kind: 'hard', dim: 'hard', id: 'education', label: `学历 ${h.value}`, weight: h.weight, status: mine >= need ? 'hit' : 'miss', mine: PROFILE.education });
    } else if (h.id === 'english') {
      items.push({ kind: 'hard', dim: 'hard', id: 'english', label: '英语能力', weight: h.weight, status: 'partial', mine: PROFILE.english });
    } else if (h.id === 'remote') {
      items.push({ kind: 'hard', dim: 'hard', id: 'remote', label: '支持远程', weight: h.weight, status: 'hit', mine: '常驻昆明，接受远程' });
    }
  }

  // 地点：非昆明且非远程 → 需搬迁
  if (job.channel === 'local' && job.city && !/昆明|云南/.test(job.city) && !job.remote) {
    items.push({ kind: 'hard', dim: 'hard', id: 'location', label: `工作地点 ${job.city}`, weight: 2, status: 'partial', mine: '常驻昆明' });
  }

  // 职级：Senior / 负责人 与当前画像有差距
  if (/(senior|staff|principal|lead|head of|高级|负责人|总监|架构师|专家)/i.test(job.title || '')) {
    items.push({
      kind: 'hard', dim: 'hard', id: 'seniority', label: '职级（Senior / 负责人）', weight: 3, status: 'partial',
      mine: '做过 FDE / 部门经理，未带过算法团队',
    });
  }
  // 海外岗：英语与时区是隐性门槛
  if (job.channel === 'overseas') {
    items.push({
      kind: 'hard', dim: 'hard', id: 'english', label: '英语 / 时区', weight: 2, status: 'partial',
      mine: 'IELTS 6.0，可书面沟通；口语待练',
    });
  }

  if (!items.length) {
    items.push({ kind: 'hard', dim: 'hard', id: 'info', label: '该来源未提供 JD', weight: 1, status: 'partial', mine: '仅能按标题与标签判断' });
  }

  // 维度得分
  const { dims, score } = scoreItems(items);

  const strengths = items.filter(i => i.status === 'hit').sort((a, b) => b.weight - a.weight).slice(0, 5);
  const gaps = items.filter(i => i.status !== 'hit').sort((a, b) => (b.weight * (1 - STATUS_VALUE[b.status])) - (a.weight * (1 - STATUS_VALUE[a.status])));

  const confidence = jd.hasJd ? 'high' : 'low';
  const n = items.length;
  const coverageCap = n <= 3 ? 70 : n <= 5 ? 85 : n <= 7 ? 91 : 95;
  const analysis = {
    score: confidence === 'low' ? Math.min(score, 55) : Math.min(score, coverageCap),
    confidence, dims, items, strengths, gaps,
    keywords: jd.skills.map(s => ({
      term: s.name, hit: (PROFILE.skills[s.id]?.level ?? 0) >= 2, partial: PROFILE.skills[s.id]?.level === 1, weight: s.weight,
    })),
    jd,
    suggestions: [],
  };
  analysis.suggestions = buildSuggestions(job, analysis);
  if (confidence === 'low') {
    analysis.suggestions.unshift({
      priority: '高', label: '信息不足', status: 'partial',
      text: '该来源只给了卡片，没有 JD。分数是低置信估计——先点「打开原站」确认职责与硬性要求，再决定投不投。',
    });
  }
  return analysis;
}

function parseYearsNum(v = '') {
  const m = String(v).match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m) return [Number(m[1]), Number(m[2])];
  const m2 = String(v).match(/(\d+)/);
  return m2 ? [Number(m2[1]), Number(m2[1])] : null;
}

const GAP_TIPS = {
  rag: '补一个 RAG 最小证据：用 TRYON 的款式/描述数据建 100–500 条向量索引，写清「召回 → 重排 → 命中率」。没有真实数据就不要写上线。',
  finetune: '微调不是你的强项：面试口径说清「我用 API + Prompt + 工作流解决，不做训练」，同时把评测/验收经验顶上来。',
  python: '把 Python 从「会」变成「可验证」：挑 TRYON 或 dsh-skills 里的一个脚本，补 README（入参/输出/运行方式），仓库有 CI 就把 badge 放首页。',
  sql: '数据能力换一种写法：「SQL/表格聚合 + 异常识别 + 口径定义」，注明数据量与更新频率。',
  deploy: '部署证据已有：TRYON 上线那句补上环境与方式（云主机 / Docker / 域名 / HTTPS），比「上线」两个字有力。',
  cloud: '把「火山方舟 API」写具体：调了哪些模型、怎么计费/限流、失败怎么降级。',
  english: '英语按真实水平写「可英文文档 + 邮件沟通」；岗位要英文晨会就标注「口语在练」，不要硬吹。',
  presales: '把 6 年业务经历翻成售前语言：「把需求翻译成可验收方案」，配一条跨部门/客户案例。',
  evals: '把「验收标准」写成一个可复用的方法：谁验收、看哪 3 个指标、不达标怎么迭代。',
  frontend: '前端不是你的主线：如果 JD 要 React，写「能读接口文档、和前端协作、自己改页面」就够了，不要写「熟练 React」。',
  container: 'Docker：TRYON 若用容器部署就补一句；没有就用「云主机 + 域名 + HTTPS」替代，不硬写 K8s。',
  'ai-general': 'AI/ML 基础是部分命中：面试口径把它转成应用侧——会选模型、写 Prompt、做评测，不做训练。',
  require: '岗位要求的核心流程你做过：把 4 条工作流按 JD 的顺序重排，先放最接近的一条。',
};

function buildSuggestions(job, a) {
  const out = [];
  const missing = a.gaps.filter(g => g.kind === 'skill' || g.kind === 'hard');
  for (const g of missing.slice(0, 3)) {
    const tip = GAP_TIPS[g.id] || `「${g.label}」缺少直接证据：要么补一个最小项目，要么在求职信里说明用哪段经历替代。`;
    out.push({ priority: g.weight >= 4 ? '高' : g.weight >= 2 ? '中' : '低', label: g.label, status: g.status, text: tip });
  }
  const hitSkills = a.strengths.filter(x => x.kind === 'skill');
  const hits = (hitSkills.length ? hitSkills : a.strengths).slice(0, 3).map(s => s.label).join('、');
  if (hits) out.push({ priority: '高', label: '概述重写', status: 'hit', text: `把概述第一句改成：「${hits} 方向，8 年业务与交付经验，独立完成 4 条 Agent 工作流与 1 个上线产品。」前 12 个字先给结论。` });
  const kw = a.keywords.filter(k => k.hit).slice(0, 5).map(k => k.term).join(' / ');
  if (kw) out.push({ priority: '中', label: '关键词对齐', status: 'hit', text: `JD 里你已命中的词：${kw}。投递前检查这些词是否在简历前 1/3 出现过；没出现的补进最近一段经历。` });
  if (job.channel === 'overseas') out.push({ priority: '中', label: '海外岗', status: 'partial', text: '英文岗需要英文简历：先用中文版定稿，再翻译；时区写清「UTC+8，可覆盖 X 小时重叠」。' });
  return out.slice(0, 5);
}

// ---------------- 定制简历 ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function tailoredSummary(job, a) {
  const skillHits = a.strengths.filter(x => x.kind === 'skill');
  const hits = (skillHits.length ? skillHits : a.strengths).slice(0, 4).map(s => s.label);
  const base = (PROFILE.summary?.[0] || `${PROFILE.years} 年经验，独立交付可上线的 AI 应用。`).replace(/^现在：/, '');
  const first = base;
  const second = `对应「${job.title || 'AI 应用'}」：${hits.length ? `已命中 ${hits.join('、')}；` : ''}先问产出与验收，再拆流程、写 Prompt、接 API、部署迭代，不停在 demo。`;
  return [first, second];
}

export function buildResumeHtml(job, a) {
  const s = tailoredSummary(job, a);
  const hit = a.keywords.filter(k => k.hit).map(k => k.term);
  const seen = new Set();
  const kw = [];
  for (const k of [...hit, ...(PROFILE.keywords || [])]) {
    const key = k.replace(/\s|\//g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); kw.push(k);
    if (kw.length >= 8) break;
  }
  const company = job.company || '目标公司';
  const title = job.title || '';
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const contact = PROFILE.contact || {};
  const edu = PROFILE.educationHistory?.[0];
  const langs = PROFILE.languages || [];

  const jobs = (PROFILE.experiences || []).map(e => `
    <div class="job">
      <div class="head"><span class="co">${esc(e.company)}</span><span class="when">${esc(e.period)}</span></div>
      ${e.role ? `<div class="role2">${esc(e.role)}</div>` : ''}
      <ul>${(e.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul>
    </div>`).join('');

  const projects = (PROFILE.projects || []).map(pr => `
    <div class="job">
      <div class="head"><span class="co">${esc(pr.name)}</span><span class="when">${esc(pr.period || '')}</span></div>
      <ul>${(pr.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul>
    </div>`).join('');

  const method = (PROFILE.method || [
    ['01', '画流程、算人工：找值得交给 Agent 的环节'],
    ['02', '定验收：产出什么、谁验收、看 3 个指标'],
    ['03', '搭工作流：Prompt → 节点 → 人工兜底'],
    ['04', '接 API 上线：部署、监控、按结果迭代'],
  ]);

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "PingFang SC", -apple-system, "Helvetica Neue", sans-serif; color: #16202b; font-size: 9.9pt; line-height: 1.7; }
  .page { width: 210mm; min-height: 297mm; display: grid; grid-template-columns: 64mm 1fr; }
  .side { background: #0E2233; color: #dfe7ee; padding: 16mm 10mm 12mm; }
  .side .name { font-size: 22pt; font-weight: 700; color: #fff; letter-spacing: .02em; }
  .side .role { margin-top: 3mm; color: #d9bb8a; font-size: 10.2pt; line-height: 1.5; }
  .side .meta { margin-top: 8mm; font-size: 8.8pt; line-height: 1.9; color: #c3d0dc; }
  .side .meta b { color: #fff; font-weight: 600; }
  .side h4 { margin: 9mm 0 2mm; font-size: 8.4pt; letter-spacing: .16em; color: #b08d57; font-weight: 600; }
  .side .kw { display: flex; flex-wrap: wrap; gap: 2mm; margin-top: 2mm; }
  .side .kw span { border: .4pt solid rgba(217,187,138,.42); color: #e8dcc8; padding: .8mm 2mm; border-radius: 1mm; font-size: 7.6pt; }
  .side .edu { font-size: 8.6pt; line-height: 1.6; color: #c3d0dc; }
  .main { padding: 16mm 14mm 12mm 12mm; }
  .main h3 { font-size: 9.2pt; letter-spacing: .18em; color: #0E2233; margin: 7.2mm 0 2.8mm; padding-bottom: 1.4mm; border-bottom: .5pt solid #d8cfbc; }
  .main h3:first-child { margin-top: 0; }
  .summary { font-size: 9.4pt; color: #26313d; }
  .summary p { margin: 0 0 1.6mm; }
  .job { margin-bottom: 4.2mm; }
  .job .head { display: flex; justify-content: space-between; align-items: baseline; }
  .job .co { font-weight: 650; font-size: 9.6pt; }
  .job .when { color: #7a8493; font-size: 7.8pt; }
  .job .role2 { color: #8a6425; font-size: 8.6pt; margin-bottom: 1mm; }
  .job ul { margin: 0; padding-left: 3.6mm; }
  .job li { margin-bottom: 1mm; font-size: 9.3pt; }
  .method { display: grid; grid-template-columns: 1fr 1fr; gap: 2.4mm 4mm; margin-top: 1mm; }
  .method div { font-size: 8.9pt; color: #33404e; padding-left: 5.4mm; position: relative; }
  .method b { position: absolute; left: 0; top: .2mm; color: #b08d57; font-size: 8.4pt; }
  .foot { margin-top: 6mm; padding-top: 2mm; border-top: .5pt solid #e2dbcd; color: #8b93a0; font-size: 7.4pt; display: flex; justify-content: space-between; }
</style></head>
<body><div class="page">
  <aside class="side">
    <div class="name">${esc(PROFILE.name)}</div>
    <div class="role">${esc(PROFILE.title)}</div>
    <div class="meta">
      <b>${esc(PROFILE.location)}</b>${PROFILE.remote ? ' · 接受远程' : ''}<br/>
      ${contact.phone ? esc(contact.phone) + '<br/>' : ''}
      ${contact.email ? esc(contact.email) + '<br/>' : ''}
      ${contact.site ? esc(contact.site) + '<br/>' : ''}
      ${contact.github ? esc(contact.github) : ''}
    </div>
    <h4>岗位关键词</h4>
    <div class="kw">${kw.map(k => `<span>${esc(k)}</span>`).join('')}</div>
    ${edu ? `<h4>教育</h4><div class="edu">${esc(edu.school)}<br/>${esc(edu.major)} · ${esc(edu.degree)}<br/>${esc(edu.period)}</div>` : ''}
    ${langs.length ? `<h4>语言</h4><div class="edu">${langs.map(esc).join('<br/>')}</div>` : ''}
  </aside>
  <main class="main">
    <h3>概述</h3>
    <div class="summary">${s.map(p => `<p>${esc(p)}</p>`).join('')}</div>

    ${method.length ? `<h3>方法</h3><div class="method">${method.map(([n, t]) => `<div><b>${esc(n)}</b>${esc(t)}</div>`).join('')}</div>` : ''}

    <h3>工作经历</h3>
    ${jobs}

    <h3>项目与开源</h3>
    ${projects}

    <div class="foot"><span>${esc(PROFILE.name)} · 定制简历</span><span>${date} · 针对 ${esc(company)}</span></div>
  </main>
</div></body></html>`;
}

export function tailoredFileName(job) {
  const clean = (x) => String(x || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 18);
  return `${clean(PROFILE.name)}_${clean(job.title)}_${clean(job.company || '公司')}_${new Date().toISOString().slice(0, 10)}.pdf`;
}
