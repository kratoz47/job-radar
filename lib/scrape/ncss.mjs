import { get } from './jobui.mjs';
import { htmlToText } from '../parse.mjs';

// 国家大学生就业服务平台：SSR 详情页，公开可抓
export async function fetchNcssJd(url) {
  const { text } = await get(url);
  const plain = htmlToText(text);
  const start = plain.indexOf('职位详情');
  if (start < 0) return null;
  let body = plain.slice(start + 4);
  for (const stop of ['面试评价', '公司信息', '该公司其他职位']) {
    const i = body.indexOf(stop);
    if (i > 0) body = body.slice(0, i);
  }
  const lines = body.split('\n').map(x => x.trim()).filter(Boolean);
  const jd = lines.filter(l => !/^(收藏|取消|举报|分享|分享给朋友|投递简历|扫码快速投递简历|查看该公司全部评价)$/.test(l)).join('\n').trim();
  return jd.length > 30 ? jd.slice(0, 4000) : null;
}
