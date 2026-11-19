// 中文关键词 → 海外站常用英文说法；只做扩展，不改用户原词
const MAP = {
  AI应用: ['ai application', 'applied ai'],
  AI落地: ['ai implementation', 'ai deployment'],
  人工智能: ['artificial intelligence'],
  大模型: ['llm', 'large language model'],
  智能体: ['agent', 'ai agent'],
  机器学习: ['machine learning'],
  产品经理: ['product manager', 'product owner'],
  项目经理: ['project manager'],
  前端: ['frontend', 'front-end'],
  后端: ['backend', 'back-end'],
  全栈: ['full stack', 'fullstack'],
  算法: ['algorithm', 'machine learning'],
  数据分析: ['data analyst', 'data analysis'],
  数据科学: ['data scientist'],
  设计师: ['designer', 'design'],
  运营: ['operations', 'operator'],
  市场: ['marketing'],
  销售: ['sales'],
  会计: ['accountant', 'accounting'],
  财务: ['finance', 'financial'],
  人事: ['human resources', 'hr'],
  招聘: ['recruiter', 'talent acquisition'],
  客服: ['customer support', 'customer service'],
  测试: ['qa', 'test engineer', 'quality assurance'],
  运维: ['devops', 'sre', 'site reliability'],
  商务: ['business development'],
  法务: ['legal'],
  行政: ['administrative', 'office manager'],
  翻译: ['translator', 'translation'],
  教师: ['teacher', 'instructor'],
  护士: ['nurse'],
  医生: ['doctor', 'physician'],
};

export function expandTerms(terms = []) {
  const out = [];
  for (const raw of terms) {
    const t = String(raw || '').trim();
    if (!t) continue;
    out.push(t);
    for (const [cn, en] of Object.entries(MAP)) {
      if (t.includes(cn)) out.push(...en);
    }
  }
  return [...new Set(out)].slice(0, 20);
}
