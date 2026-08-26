// 指针 v7b 长链诊断 — 一次性脚本（Playwright 驱动系统 Chrome, evaluate 可编程搭场景）
// 用法: npm run dev 起服务器后 → node scripts/debug-pointer-log.mjs
// 产物:
//   gui-test-screenshots/v7b-long-XX.png  连拍帧（默认相机视野, 列32竖链 9 格）
//   控制台: beltStatus / pointerLog(100) 全文
import { mkdirSync, writeFileSync } from 'node:fs';

const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const { chromium } = await import(PW_URL);

const OUT = 'gui-test-screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto('http://localhost:5173/');
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 30000 });
await page.waitForTimeout(1500);

// 场景: 取货口 (31..33,37)，中口向上 9 格链 (32,36)..(32,28)，断头
const setup = await page.evaluate(() => {
  const g = window.__game;
  g.clearAllPlaced();
  const u = g.placeAt('depot_unloader', 31, 37);
  const cells = [];
  for (let y = 36; y >= 28; y--) cells.push([32, y]);
  const n = g.spawnBelt(cells, 270);
  return { unloader: !!u, beltCells: n };
});
console.log('[setup]', JSON.stringify(setup));

// 模拟取货口节奏注料: 每 2s 一件（spawnBelt 不带料, injectBeltItem 注入段首）
// 首件等流到中段再截帧; 全程 24s, 每 800ms 一帧
const frames = 26;
for (let i = 0; i < frames; i++) {
  if (i % 4 === 0) {
    await page.evaluate(() => { try { window.__game.injectBeltItem('originium_ore'); } catch {} });
  }
  await page.screenshot({ path: `${OUT}/v7b-long-${String(i).padStart(2, '0')}.png`, clip: { x: 580, y: 80, width: 130, height: 620 } });
  await page.waitForTimeout(700);
}

const belts = await page.evaluate(() => window.__game.beltStatus());
const plog = await page.evaluate(() => window.__game.pointerLog(100));
console.log('===== beltStatus =====\n' + belts);
console.log('===== pointerLog =====\n' + plog);
writeFileSync(`${OUT}/v7b-long-log.txt`, belts + '\n=====\n' + plog);

await browser.close();
console.log('[done] frames ->', OUT);
