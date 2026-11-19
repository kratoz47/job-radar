// 岗位需求结构化：把 JD 文本拆成职责 / 要求 / 硬性条件 / 技能，并给出权重

const HEADINGS = {
  duties: /^(岗位职责|工作职责|职位职责|工作内容|你将负责|负责内容|主要职责|职责描述|what you.?ll do|responsibilities|the role|about the role|your role|day to day)/i,
  requirements: /^(任职要求|岗位要求|职位要求|技能要求|任职资格|我们希望你|你需要|要求|qualifications|requirements|what we.?re looking for|you have|must have|nice to have|about you|skills)/i,
  benefits: /^(薪资|福利|待遇|我们提供|加分项|benefits|perks|compensation|why join)/i,
};

export const SKILLS = [
  { id: 'ai-general', name: 'AI / ML 基础', dim: 'ai', aliases: ['ai', 'artificial intelligence', 'machine learning', '机器学习', 'ml', '人工智能'] },
  { id: 'ml-eng', name: '深度学习 / 推荐', dim: 'ai', aliases: ['深度学习', 'pytorch', 'tensorflow', '推荐系统', '推荐算法', '特征工程', '模型训练', '算法建模', '算法工程师', 'nlp', 'cv', 'inference', '推理', 'vllm', 'sglang', 'tensorrt'] },
  { id: 'agent', name: 'Agent / 智能体', dim: 'ai', aliases: ['agent', '智能体', '多 agent', 'multi-agent', '工作流', 'workflow', 'autogen', 'langgraph', 'dify'] },
  { id: 'llm-app', name: '大模型应用', dim: 'ai', aliases: ['大模型', 'llm', '大语言模型', 'gpt', '生成式', 'genai', 'aigc', 'chatgpt', 'claude'] },
  { id: 'prompt', name: 'Prompt 工程', dim: 'ai', aliases: ['prompt', '提示词', '提示工程'] },
  { id: 'rag', name: 'RAG / 知识库', dim: 'ai', aliases: ['rag', '知识库', '向量', 'embedding', '检索增强', '召回', '重排', 'rerank', 'milvus', 'faiss', 'chroma'] },
  { id: 'finetune', name: '模型微调', dim: 'ai', aliases: ['微调', 'fine-tune', 'finetune', 'lora', 'sft', '训练模型'] },
  { id: 'evals', name: '评测 / 验收', dim: 'ai', aliases: ['评测', '评估', '验收', '指标', 'eval', 'benchmark'] },
  { id: 'multimodal', name: '多模态', dim: 'ai', aliases: ['多模态', 'multimodal', '视觉', '语音', 'ocr', '图像生成', '生图'] },

  { id: 'python', name: 'Python', dim: 'eng', aliases: ['python', 'fastapi', 'flask', 'django'] },
  { id: 'golang', name: 'Go', dim: 'eng', aliases: ['golang', 'go 语言', 'go语言'] },
  { id: 'java', name: 'Java', dim: 'eng', aliases: ['java', 'spring boot', 'springboot'] },
  { id: 'api', name: 'API / 集成', dim: 'eng', aliases: ['api', '接口', '集成', 'integration', 'webhook', 'sdk'] },
  { id: 'deploy', name: '部署 / 上线', dim: 'eng', aliases: ['部署', '上线', '交付', 'deploy', '运维', 'devops'] },
  { id: 'container', name: 'Docker / K8s', dim: 'eng', aliases: ['docker', 'k8s', 'kubernetes', '容器化'] },
  { id: 'frontend', name: '前端 / React', dim: 'eng', aliases: ['react', 'vue', 'typescript', '前端', 'next.js', 'javascript'] },
  { id: 'sql', name: 'SQL / 数据库', dim: 'eng', aliases: ['sql', 'mysql', 'postgres', '数据库', 'redis', 'mongodb'] },
  { id: 'git', name: 'Git / CI', dim: 'eng', aliases: ['git', 'github', 'ci/cd', 'ci', '版本管理'] },
  { id: 'cloud', name: '云服务', dim: 'eng', aliases: ['阿里云', 'aws', 'azure', '腾讯云', '火山', '云服务', '云平台'] },
  { id: 'swift', name: 'Swift / 端侧', dim: 'eng', aliases: ['swift', 'ios', 'macos', 'vision'] },

  { id: 'requirements', name: '需求拆解', dim: 'biz', aliases: ['需求分析', '需求拆解', '需求梳理', '业务分析', '验收标准', '方案设计'] },
  { id: 'project', name: '项目管理 / 交付', dim: 'biz', aliases: ['项目管理', '交付', '实施', '落地', '推进', '敏捷', 'scrum', 'pm'] },
  { id: 'presales', name: '售前 / 客户', dim: 'biz', aliases: ['售前', '解决方案', '客户成功', '客户沟通', 'consult', 'pre-sales', 'solution'] },
  { id: 'data-analysis', name: '数据分析 / 看板', dim: 'biz', aliases: ['数据分析', '看板', '报表', 'bi', '数据汇总', '指标体系'] },
  { id: 'team', name: '团队管理', dim: 'biz', aliases: ['团队管理', '带团队', '管理经验', 'lead', 'mentor', '主管'] },
  { id: 'ecommerce', name: '电商 / 供应链', dim: 'biz', aliases: ['电商', '生鲜', '供应链', '零售', '履约', 'gmv', '选品'] },
  { id: 'mcn', name: '内容 / MCN', dim: 'biz', aliases: ['mcn', '短视频', '直播', '内容运营', '达人', 'kol', '新媒体'] },
  { id: 'finance-domain', name: '财务 / 金融', dim: 'biz', aliases: ['财务', '金融', '会计', '风控', '基金', '支付'] },
  { id: 'cs-agent', name: '客服 / 招聘 Agent', dim: 'biz', aliases: ['客服', '招聘', 'crm', '坐席', '工单'] },
  { id: 'video', name: '视频 / 剪辑', dim: 'biz', aliases: ['视频', '剪辑', '粗剪', '字幕'] },

  { id: 'feishu', name: '飞书 / 协作工具', dim: 'tool', aliases: ['飞书', 'lark', '钉钉', '企业微信', 'notion'] },
  { id: 'openclaw', name: 'OpenClaw / Agent 框架', dim: 'tool', aliases: ['openclaw', 'clawdbot', 'moltbot'] },
  { id: 'volc', name: '火山方舟 / 模型 API', dim: 'tool', aliases: ['火山方舟', '方舟', '豆包', '通义', '文心'] },
];

export const HARD = [
  { id: 'years', name: '经验年限', dim: 'hard' },
  { id: 'education', name: '学历', dim: 'hard' },
  { id: 'english', name: '英语', dim: 'hard' },
  { id: 'remote', name: '远程 / 到岗', dim: 'hard' },
];

function aliasRegex(alias) {
  const a = alias.toLowerCase();
  if (/^[a-z0-9+#./-]+$/.test(a)) return new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
  return null;
}

const ALIAS_CACHE = new Map();
function hasAlias(text, alias) {
  const re = ALIAS_CACHE.get(alias) ?? (ALIAS_CACHE.set(alias, aliasRegex(alias)), ALIAS_CACHE.get(alias));
  return re ? re.test(text) : text.includes(alias.toLowerCase());
}

export function cleanJd(text = '') {
  return String(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/(\d+)[.、]\s*/g, '\n$1. ')
    .replace(/[；;]\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitBullets(text) {
  return text
    .split('\n')
    .map(l => l.replace(/^[-•*·\d.、)\s]+/, '').trim())
    .filter(l => l.length >= 4)
    .slice(0, 12);
}

export function parseJD(raw = '', job = {}) {
  const text = cleanJd(raw || '');
  const lines = text.split('\n');
  const sections = { duties: [], requirements: [], benefits: [] };
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (HEADINGS.benefits.test(line)) { current = 'benefits'; continue; }
    if (HEADINGS.requirements.test(line) && line.length <= 30) { current = 'requirements'; continue; }
    if (HEADINGS.duties.test(line) && line.length <= 30) { current = 'duties'; continue; }
    if (current) sections[current].push(line);
  }

  // 没有标题时按比例切分
  if (!sections.duties.length && !sections.requirements.length && text) {
    const all = lines.filter(Boolean);
    const cut = Math.ceil(all.length * 0.45);
    sections.duties = all.slice(0, cut);
    sections.requirements = all.slice(cut);
  } else if (!sections.requirements.length) {
    sections.requirements = sections.duties.splice(Math.ceil(sections.duties.length * 0.6));
  }

  const duties = splitBullets(sections.duties.join('\n'));
  const requirements = splitBullets(sections.requirements.join('\n'));
  const reqText = requirements.join(' ');
  const dutyText = duties.join(' ');

  // 技能命中：标题 > 要求 > 职责
  const title = `${job.title || ''} ${(job.tags || []).join(' ')}`;
  const skills = [];
  for (const s of SKILLS) {
    const inTitle = s.aliases.some(a => hasAlias(title, a));
    const inReq = s.aliases.some(a => hasAlias(reqText, a));
    const inDuty = s.aliases.some(a => hasAlias(dutyText, a));
    const inAll = s.aliases.some(a => hasAlias(text, a)) || inTitle;
    if (!inAll) continue;
    let weight = 0;
    if (inTitle) weight += 4;
    if (inReq) weight += 3;
    if (inDuty) weight += 2;
    if (!weight) weight = 1;
    skills.push({ ...s, weight: Math.min(6, weight), where: [inTitle && '标题', inReq && '要求', inDuty && '职责'].filter(Boolean) });
  }
  skills.sort((a, b) => b.weight - a.weight);

  // 硬性条件
  const years = parseYears(reqText || text);
  const education = parseEducation(reqText || text);
  const english = /英语|english|cet-?[46]|ielts|托福|toefl/i.test(reqText || text);
  const remote = /远程|remote|居家|home ?office/i.test(`${job.location || ''} ${reqText} ${text}`);
  const hard = [];
  if (years) hard.push({ id: 'years', name: '经验年限', value: years, weight: 3 });
  if (education) hard.push({ id: 'education', name: '学历', value: education, weight: 3 });
  if (english) hard.push({ id: 'english', name: '英语', value: '要求英语能力', weight: 2 });
  if (remote) hard.push({ id: 'remote', name: '远程 / 到岗', value: '支持远程', weight: 1 });

  return {
    duties: duties.slice(0, 8),
    requirements: requirements.slice(0, 10),
    skills: skills.slice(0, 14),
    hard,
    raw: text,
    hasJd: (duties.length + requirements.length) >= 3 && text.length >= 80,
  };
}

function parseYears(text) {
  const m = text.match(/(\d+)\s*[-~到至]\s*(\d+)\s*年/);
  if (m) return `${m[1]}–${m[2]} 年`;
  const m2 = text.match(/(\d+)\s*年(?:以上|及以上)?(?:的)?(?:工作|相关|开发|经验)/) || text.match(/(\d+)\s*\+?\s*years?/i);
  if (m2) return `${m2[1]}+ 年`;
  if (/不限经验|经验不限/.test(text)) return '不限';
  return null;
}

function parseEducation(text) {
  if (/博士/.test(text)) return '博士';
  if (/硕士|研究生|master/i.test(text)) return '硕士';
  if (/本科|学士|bachelor/i.test(text)) return '本科';
  if (/大专|专科/.test(text)) return '大专';
  return null;
}
