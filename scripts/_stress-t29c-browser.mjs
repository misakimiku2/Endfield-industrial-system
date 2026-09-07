// T2.29-c 浏览器视觉验证 — 用法: 先启动 dev server（npm run dev），然后:
//   node scripts/_stress-t29c-browser.mjs
// 截图输出: log/t29c-s*.png
//
// 三个场景（截图由人/读图模型核验）:
//   S1 空带不同步: 先后（间隔 ≥3s 真实时间）创建 3 条平行 5 格空带（无供料设备），
//      等 10s，截 3 张全屏 PNG（间隔 0.5s）。核验: 每条带箭头都在移动、三带相位
//      明显不同、绝无静止。
//   S2 取货口前导空格: depot_unloader + 8 格带，跑 30s，每 2s 截 1 张（15 张）。
//      核验: 物品身后到带尾被指针填满（无空白格），紧邻物品前方一格必须有指针;
//      不应出现"孤零零一支指针 → 下一张变物品"的序列（注入杀发生在物品身下）。
//   S3 满载无下骑: 精炼炉（输入塞 999999 源矿）+ 6 格带 + 末端 depot_loader，
//      跑 60s 至稳态满载，截 3 张。核验: 密集物品流下方无指针穿行/跟行。

const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const OUT_DIR = 'log';
const CELL = 64;

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

/** 相机对准某格（设 zoom 后再设中心，绕过 clamp 差异），CELL=64。 */
const focus = async (gx, gy, zoom = 0.6) => {
  await page.evaluate(({ gx, gy, zoom }) => {
    const g = window.__game;
    g.camera.setZoom(zoom);
    g.camera.x = (gx + 0.5) * 64;
    g.camera.y = (gy + 0.5) * 64;
  }, { gx, gy, zoom });
  await page.waitForTimeout(300);
};

/** 建一条竖直向上（direction 270）的直链带，返回实际创建段数。 */
const spawnBeltUp = (x, yTop, len) => page.evaluate(({ x, yTop, len }) => {
  const cells = [];
  for (let i = 0; i < len; i++) cells.push([x, yTop - i]);
  return window.__game.spawnBelt(cells, 270);
}, { x, yTop, len });

/** 链上物品总数（诊断读数，不参与判定视觉结论）。 */
const beltItemCount = () => page.evaluate(() => {
  const g = window.__game;
  let n = 0;
  for (const h of g.world.query('BeltSegmentComp')) {
    const seg = g.world.getComponent(h, 'BeltSegmentComp');
    n += (seg.items ?? []).length;
  }
  return n;
});

await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 20000 });
await page.waitForTimeout(2500); // 等资产/首帧
await page.bringToFront();

// ═══════════ S1: 空带不同步 ═══════════
console.log('\n[S1] 空带不同步: 3 条平行 5 格空带，创建间隔 3.2s，等 10s 后连拍 3 张（间隔 0.5s）');
await page.evaluate(() => window.__game.clearAllPlaced());
await focus(8, 7, 0.6);
const c1 = await spawnBeltUp(5, 9, 5);
await page.waitForTimeout(3200);
const c2 = await spawnBeltUp(8, 9, 5);
await page.waitForTimeout(3200);
const c3 = await spawnBeltUp(11, 9, 5);
ok(c1 === 5 && c2 === 5 && c3 === 5, `S1 前置: 3 条 5 格空带创建（实际 ${c1}/${c2}/${c3} 段）`);
const itemCount1 = await beltItemCount();
ok(itemCount1 === 0, `S1 前置: 带上无任何物品（${itemCount1} 件，纯空带场景）`);
await page.waitForTimeout(10000);
for (let i = 1; i <= 3; i++) {
  await shot(`t29c-s1-${i}`);
  if (i < 3) await page.waitForTimeout(500);
}
console.log('  截图: log/t29c-s1-1.png ~ t29c-s1-3.png（0.5s 间隔，读图对比箭头位置/相位/静止）');

// ═══════════ S2: 取货口前导空格 ═══════════
console.log('\n[S2] 取货口前导空格: depot_unloader(4,10,180°) + 8 格带 (5,9)→(5,2)，跑 30s 每 2s 截 1 张');
await page.evaluate(() => window.__game.clearAllPlaced());
await focus(5, 6, 0.6);
const placed = await page.evaluate(() => window.__game.placeAt('depot_unloader', 4, 10, 180));
ok(placed, 'S2 前置: depot_unloader 放置成功');
const beltN = await spawnBeltUp(5, 9, 8);
ok(beltN === 8, `S2 前置: 8 格传送带创建（实际 ${beltN} 段）`);
await page.waitForTimeout(5000);
const items2 = await beltItemCount();
ok(items2 > 0, `S2 前置: 取货口已上料（带上物品 ${items2} 件）`);
for (let i = 1; i <= 15; i++) {
  await shot(`t29c-s2-${String(i).padStart(2, '0')}`);
  await page.waitForTimeout(2000);
}
console.log('  截图: log/t29c-s2-01.png ~ t29c-s2-15.png（2s 间隔，读图核验无前导空格/无可见注入闪变）');

// ═══════════ S3: 满载无下骑 ═══════════
console.log('\n[S3] 满载无下骑: 精炼炉(输入 999999 源矿) + 6 格带 + 存货口，跑 60s 至稳态满载，截 3 张');
await page.evaluate(() => window.__game.clearAllPlaced());
await focus(5, 8, 0.6);
const fPlaced = await page.evaluate(() => window.__game.placeAt('refining_unit', 5, 12, 0));
ok(fPlaced, 'S3 前置: refining_unit 放置成功');
const beltN3 = await spawnBeltUp(5, 11, 6);
ok(beltN3 === 6, `S3 前置: 6 格传送带创建（实际 ${beltN3} 段）`);
const sinkPlaced = await page.evaluate(() => window.__game.placeAt('depot_loader', 4, 5, 180));
ok(sinkPlaced, 'S3 前置: depot_loader 放置成功');
const fill = await page.evaluate(() => {
  const g = window.__game;
  let filled = 0;
  for (const h of g.world.query('BuildingComp')) {
    const c = g.world.getComponent(h, 'BuildingComp');
    if (c.definitionId === 'refining_unit') {
      c.bufferInput[0] = { itemId: 'originium_ore', count: 999999 };
      filled = c.bufferInput[0].count;
    }
  }
  g.game.update();
  return filled;
});
ok(fill === 999999, `S3 前置: 精炼炉输入槽塞满源矿（${fill}）`);
await page.waitForTimeout(60000); // 跑至稳态满载（40 Tick/件 × 6 格 ≈ 4.8s/循环，60s 足够）
const items3 = await beltItemCount();
ok(items3 >= 5, `S3 前置: 稳态带上物品数 ${items3}（期望 ≥5，6 格链密集满载）`);
for (let i = 1; i <= 3; i++) {
  await shot(`t29c-s3-${i}`);
  if (i < 3) await page.waitForTimeout(700);
}
console.log('  截图: log/t29c-s3-1.png ~ t29c-s3-3.png（读图核验物品流下方无指针跟行）');

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败（视觉结论见读图核验报告）`);
process.exit(failed > 0 ? 1 : 0);
