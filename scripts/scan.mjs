import { runScan } from '../lib/scrape/index.mjs';

const t0 = Date.now();
const { stats, log } = await runScan({ onLog: (m) => console.log(m) });
console.log('\n—— 扫描完成 ——');
console.log(JSON.stringify(stats, null, 2));
console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，日志 ${log.length} 行`);
