// T2.29-c 场景1复验（哈希相位修复后）— node scripts/_stress-t29c-s1v2.mjs
// 流程同 _stress-t29c-browser.mjs 场景1: 先后间隔 ≥3 秒创建 3 条平行 5 格空带
// （无供料设备），等 10 秒，截 3 张全屏 PNG（间隔 0.5s）→ log/t29c-s1v2-*.png
const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const OUT_DIR = 'log';

const { chromium } = await import(PW_URL);
import { mkdirSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
};

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
const shot = (name) => page.screenshot({ path: `${OUT_DIR}/${name}.png` });

await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 20000 });
await page.waitForTimeout(2500);
await page.bringToFront();

console.log('[S1v2] 空带不同步复验: 3 条平行 5 格空带，创建间隔 3.2s，等 10s 后连拍 3 张（间隔 0.5s）');
await page.evaluate(() => window.__game.clearAllPlaced());
await page.evaluate(({ gx, gy, zoom }) => {
  const g = window.__game;
  g.camera.setZoom(zoom);
  g.camera.x = (gx + 0.5) * 64;
  g.camera.y = (gy + 0.5) * 64;
}, { gx: 8, gy: 7, zoom: 0.6 });
await page.waitForTimeout(300);

const spawnBeltUp = (x, yTop, len) => page.evaluate(({ x, yTop, len }) => {
  const cells = [];
  for (let i = 0; i < len; i++) cells.push([x, yTop - i]);
  const n = window.__game.spawnBelt(cells, 270);
  // 回读 chainId 供哈希相位对照
  let ids = [];
  for (const h of window.__game.world.query('BeltSegmentComp')) {
    const seg = window.__game.world.getComponent(h, 'BeltSegmentComp');
    if (ids.length === 0 || ids[ids.length - 1] !== seg.chainId) ids.push(seg.chainId);
  }
  return { n, ids };
}, { x, yTop, len });

const b1 = await spawnBeltUp(5, 9, 5);
await page.waitForTimeout(3200);
const b2 = await spawnBeltUp(8, 9, 5);
await page.waitForTimeout(3200);
const b3 = await spawnBeltUp(11, 9, 5);
ok(b1.n === 5 && b2.n === 5 && b3.n === 5, `3 条 5 格空带创建（实际 ${b1.n}/${b2.n}/${b3.n} 段）`);
console.log(`  chainId: ${b1.ids[0]} | ${b2.ids[0]} | ${b3.ids[0]}`);
const itemCount = await page.evaluate(() => {
  const g = window.__game;
  let n = 0;
  for (const h of g.world.query('BeltSegmentComp')) {
    n += (g.world.getComponent(h, 'BeltSegmentComp').items ?? []).length;
  }
  return n;
});
ok(itemCount === 0, `带上无任何物品（${itemCount} 件，纯空带场景）`);
await page.waitForTimeout(10000);
for (let i = 1; i <= 3; i++) {
  await shot(`t29c-s1v2-${i}`);
  if (i < 3) await page.waitForTimeout(500);
}
console.log('  截图: log/t29c-s1v2-1.png ~ t29c-s1v2-3.png');

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
