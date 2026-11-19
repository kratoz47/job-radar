// 投递建议：一、高匹配直投；二、远程叠加（身兼数职）的时间换收益
import { analyzeJob, scoreItems, PROFILE } from './profile.mjs';

// 掌握一项技能所需的有效学习天数（保守估计，按「能做出最小可验证例子」算）
const LEARN_DAYS = {
  rag: 3, container: 2, frontend: 6, python: 4, sql: 3, cloud: 2,
  deploy: 1, api: 1, git: 1, feishu: 1, volc: 1, multimodal: 3,
  evals: 2, prompt: 1, agent: 3, 'llm-app': 2, presales: 2,
  'data-analysis': 1, 'cs-agent': 2, video: 2,
};

const HIGH_MATCH_MIN = 65;
const DEFAULT_HOURS = 50;

function monthlySalary(job) {
  if (job.salary_min == null && job.salary_max == null) return null;
  const v = job.salary_max ?? job.salary_min;
  if (job.salary_currency === 'USD' || job.salary_currency === 'EUR') return null;
  const per = job.salary_period || 'month';
  if (per === 'year') return v / 12;
  if (per === 'day') return v * 21.75;
  if (per === 'hour') return v * 174;
  return v;
}

function safeTags(t) {
  try { return JSON.parse(t || '[]'); } catch { return []; }
}

function slim(job) {
  return {
    id: job.id, title: job.title, company: job.company, source: job.source,
    salary_raw: job.salary_raw, salary_min: job.salary_min, salary_max: job.salary_max,
    salary_currency: job.salary_currency, salary_period: job.salary_period,
    location: job.location, remote: !!job.remote, channel: job.channel,
    posted_at: job.posted_at, match_score: job.match_score, url: job.url,
    original_url: job.original_url, tags: safeTags(job.tags),
  };
}

function learnableGaps(analysis) {
  const out = [];
  for (const i of analysis.items) {
    if (i.kind !== 'skill' || i.status === 'hit') continue;
    const base = LEARN_DAYS[i.id];
    if (!base) continue;
    const level = PROFILE.skills[i.id]?.level ?? 0;
    if (level >= 2) continue;
    const days = Math.max(1, Math.ceil(level === 1 ? base * 0.6 : base));
    if (days > 7) continue;
    out.push({ id: i.id, label: i.label, days, weight: i.weight, from: i.status });
  }
  return out.sort((a, b) => b.weight - a.weight || a.days - b.days);
}

function blockedByHard(analysis) {
  return analysis.items.some(i => i.kind === 'hard' && i.status === 'miss' && ['education', 'years'].includes(i.id));
}

// ---------------- 交付难度 ----------------
function deliveryProfile(job) {
  const text = `${job.title || ''} ${job.summary || ''} ${(job.tags || []).join(' ')}`;
  const f = {
    client: /驻场|客户现场|出差|实施交付|交付压力|售前|客户成功|csm|咨询|顾问|solution/i.test(text),
    meeting: /会议|standup|daily stand|sync|demo|汇报|周会|例会/i.test(text),
    manage: /负责人|总监|经理|主管|带团队|团队管理|管理岗|lead|head of|mentor/i.test(text),
    tz: /(pst|pdt|est|edt|us time|america|emea|europe|london|时区|overlap|overlapping|美西|美东|欧洲|北美)/i.test(text),
    async: /异步协作|async culture|fully remote|fully-remote|remote first|remote-first|弹性工作|结果导向|自驱|flexible hours|own your time|async communication/i.test(text),
    parttime: /兼职|项目制|part-time|contract|按件|freelance/i.test(text),
    english: /fluent|native|口语|英文会议|english speaking/i.test(text),
    fulltime: /全职|full[- ]time/i.test(text),
  };
  let d = 20;
  if (f.client) d += 32;
  if (f.meeting) d += 12;
  if (f.manage) d += 16;
  if (f.tz) d += 22;
  if (f.english) d += 10;
  if (f.async) d -= 22;
  if (f.parttime) d -= 18;
  if (f.fulltime) d += 6;
  d = Math.max(5, Math.min(95, d));

  const hours = Math.round((f.parttime ? 10 : 16) + d * 0.25);
  const risks = [];
  if (f.tz) risks.push('时区要重叠');
  if (f.client) risks.push('客户/交付侧，会议出差多');
  if (f.meeting) risks.push('会议密度高');
  if (f.manage) risks.push('管理岗，会议多');
  if (f.parttime) risks.push('兼职/项目制，收入不稳');
  if (!f.async) risks.push('未提异步，默认按在线响应估');
  return { difficulty: d, hours, flags: f, risks };
}

function buildCandidate(job, analysis) {
  const gaps = learnableGaps(analysis);
  const learnDays = gaps.reduce((n, g) => n + g.days, 0);
  const coreGaps = analysis.items.filter(i => i.kind === 'skill' && i.status === 'miss' &&
    ['ml-eng', 'golang', 'java', 'finetune'].includes(i.id) && i.weight >= 4).length;
  const { difficulty, hours, flags, risks } = deliveryProfile(job);
  const salary = monthlySalary(job);
  const income = salary ?? 15000;
  const seniority = analysis.items.some(i => i.id === 'seniority' && i.status !== 'hit');

  let stackability = 100 - difficulty - coreGaps * 12 - (seniority ? 6 : 0) + (flags.async ? 6 : 0);
  stackability = Math.max(5, Math.min(95, Math.round(stackability)));

  const score =
    0.55 * stackability +
    0.25 * Math.min(100, income / 250) +
    0.2 * (learnDays <= 5 ? 90 : learnDays <= 10 ? 65 : 40) -
    (coreGaps ? 15 : 0);

  return {
    job: slim(job), analysis,
    income, estimatedIncome: salary == null,
    hours, difficulty, stackability,
    learnDays, gaps: gaps.slice(0, 4), coreGaps,
    flags, risks,
    score: Math.round(score),
    seniority,
  };
}

// ---------------- 主入口 ----------------
export function buildRecommendations(jobs, { highLimit = 6, hours = DEFAULT_HOURS } = {}) {
  const analysed = [];
  for (const job of jobs) {
    try {
      const j = { ...job, tags: safeTags(job.tags) };
      analysed.push({ job: j, analysis: analyzeJob(j) });
    } catch { /* skip */ }
  }

  // 一、现在就能投：匹配高、要补的课少
  const high = analysed
    .filter(({ analysis }) => analysis.confidence === 'high' && analysis.score >= HIGH_MATCH_MIN)
    .filter(({ analysis }) => learnableGaps(analysis).reduce((n, g) => n + g.days, 0) <= 1)
    .sort((a, b) => b.analysis.score - a.analysis.score)
    .slice(0, highLimit)
    .map(({ job, analysis }) => {
      const gaps = analysis.gaps.filter(g => g.kind === 'skill');
      const strengths = analysis.strengths.filter(s => s.kind === 'skill').slice(0, 3).map(s => s.label).join('、');
      const reason = gaps.length
        ? `已命中 ${strengths}；缺口 ${gaps.slice(0, 2).map(g => g.label).join('、')} 不挡投`
        : `已命中 ${strengths}；没有硬缺口，现在就能投`;
      return {
        job: slim(job), score: analysis.score, reason,
        gaps: gaps.slice(0, 3).map(g => g.label),
        candidates: gaps.length === 0,
      };
    });

  // 二、远程叠加：交付难度 × 收入 × 缺口可补性
  const pool = [];
  for (const { job, analysis } of analysed) {
    if (!job.remote) continue;                      // 只考虑远程
    if (analysis.confidence !== 'high') continue;   // 没有 JD 的不判断交付难度
    if (blockedByHard(analysis)) continue;          // 学历/年限硬伤
    if (analysis.score < 35) continue;              // 完全不沾边的不编
    pool.push(buildCandidate(job, analysis));
  }
  pool.sort((a, b) => b.score - a.score);
  const candidates = pool.slice(0, 10);

  // 组合：2–3 份，受每周小时预算约束
  const combos = [];
  const n = candidates.length;
  for (let size = 2; size <= 3; size++) {
    const idx = Array.from({ length: size }, (_, i) => i);
    while (idx[idx.length - 1] < n) {
      const set = idx.map(i => candidates[i]);
      const totalHours = set.reduce((s, c) => s + c.hours, 0);
      const tzCount = set.filter(c => c.flags.tz).length;
      const heavy = set.filter(c => c.difficulty >= 65).length;
      const companies = set.map(c => (c.job.company || c.job.id).toLowerCase());
      const dupCompany = new Set(companies).size !== companies.length;
      if (totalHours <= hours && tzCount <= 1 && heavy <= 1 && !dupCompany) {
        const totalIncome = set.reduce((s, c) => s + c.income, 0);
        const avgStack = Math.round(set.reduce((s, c) => s + c.stackability, 0) / size);
        const score = (totalIncome / 10000) * (avgStack / 100) * (1 - Math.max(0, totalHours - hours) / 25);
        combos.push({
          size, totalIncome, totalHours, avgStack,
          score: Math.round(score * 100) / 100,
          jobs: set.map(c => ({
            job: c.job, income: c.income, estimatedIncome: c.estimatedIncome,
            hours: c.hours, difficulty: c.difficulty, stackability: c.stackability,
            learnDays: c.learnDays, risks: c.risks,
          })),
          note: size === 3
            ? '三份属于激进叠加：先确认合同兼职条款，再排时区与会议冲突'
            : heavy
              ? '一重一轻：重交付那份要占掉大部分白天，另一份尽量选异步'
              : '两份都偏轻交付，前提是甲方按产出验收而不是按在线时长',
        });
      }
      let i = size - 1;
      while (i >= 0 && idx[i] === n - size + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let k = i + 1; k < size; k++) idx[k] = idx[k - 1] + 1;
    }
  }
  combos.sort((a, b) => b.score - a.score);

  return {
    generatedAt: new Date().toISOString(),
    hours,
    high,
    stacking: {
      candidates: candidates.map(c => ({
        job: c.job, income: c.income, estimatedIncome: c.estimatedIncome,
        hours: c.hours, difficulty: c.difficulty, stackability: c.stackability,
        learnDays: c.learnDays, coreGaps: c.coreGaps, risks: c.risks,
        flags: c.flags, score: c.score,
        reason: `${c.learnDays ? `缺口 ${c.gaps.map(g => g.label + ' ' + g.days + '天').join('、')} 可补；` : '无明显技能缺口；'}交付难度 ${c.difficulty}，约 ${c.hours} 小时/周`,
      })),
      combos: combos.slice(0, 2),
    },
    stats: {
      total: jobs.length,
      highCount: high.length,
      remoteCount: pool.length,
      comboCount: Math.min(2, combos.length),
      estimatedCount: candidates.filter(c => c.estimatedIncome).length,
    },
  };
}
