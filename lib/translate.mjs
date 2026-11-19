// 英文 JD 翻译：MyMemory 公开接口，按句切块，无需 key
const API = 'https://api.mymemory.translated.net/get';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function chunk(text, max = 450) {
  const parts = String(text).split(/\n+/).flatMap(p => p.match(/[^.!?。！？]+[.!?。！？]?/g) || [p]);
  const out = [];
  let buf = '';
  for (const p of parts) {
    const piece = p.trim();
    if (!piece) continue;
    if ((buf + ' ' + piece).length > max && buf) { out.push(buf.trim()); buf = piece; }
    else buf = buf ? buf + ' ' + piece : piece;
    while (buf.length > max) { out.push(buf.slice(0, max)); buf = buf.slice(max); }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.slice(0, 24);
}

export async function translateText(text, { from = 'en', to = 'zh-CN' } = {}) {
  if (!text || !text.trim()) return '';
  const pieces = chunk(text);
  const out = new Array(pieces.length);
  let cursor = 0;

  async function worker() {
    while (cursor < pieces.length) {
      const i = cursor++;
      const url = `${API}?q=${encodeURIComponent(pieces[i])}&langpair=${from}|${to}`;
      let data;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        data = await res.json();
      } catch (e) {
        throw new Error('翻译服务不可用：' + e.message);
      }
      const t = data?.responseData?.translatedText;
      if (!t) throw new Error('翻译失败：' + (data?.responseDetails || '空结果'));
      out[i] = t.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      await sleep(120);
    }
  }
  await Promise.all([worker(), worker()]);
  return out.filter(Boolean).join('\n');
}
