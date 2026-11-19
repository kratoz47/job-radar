// Playwright 定位：优先本地依赖，其次本机全局安装
let mod;
try {
  mod = await import('playwright');
} catch {
  mod = await import(process.env.PLAYWRIGHT_MODULE || '/opt/homebrew/lib/node_modules/playwright/index.mjs');
}
export const { chromium } = mod;
