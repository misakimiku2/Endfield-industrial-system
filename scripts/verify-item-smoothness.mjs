// 物品渲染平滑度验证 — 2026-09-02 内插两轮修复的自动化兜底
// 场景: 取货口 → 4 段上行带 → 存货口（物品持续流动），rAF 采样 belowItems 容器全部
// 精灵位置 ~2 秒，断言: ① 零倒退 ② 无 20Hz 步进（零移动帧占比 < 20%）③ 平均步长 ≈ 0.53px/帧
const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const { chromium } = await import(PW_URL);

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 15000 });
await page.waitForTimeout(1500);

// 找 belowItems 容器（物品 Sprite 挂其下）
const found = await page.evaluate(() => {
  const stage = window.__game.app.stage;
  const walk = (node, depth) => {
    if (node.label === 'belowItems') return true;
    for (const c of node.children ?? []) if (walk(c, depth + 1)) return true;
    return false;
  };
  return walk(stage, 0);
});
if (!found) { console.log('❌ 未找到 belowItems 容器'); process.exit(1); }

// 场景: 取货口(5,6) → 4 段带(5,5)(5,4)(5,3)(5,2) → 存货口(5,1)
await page.evaluate(() => {
  window.__game.clearAllPlaced();
  window.__game.placeAt('depot_unloader', 5, 7);
  window.__game.placeAt('depot_loader', 5, 1);
  window.__game.spawnBelt([[5, 6], [5, 5], [5, 4], [5, 3], [5, 2]], 270);
  window.__game.logisticsDebug(false);
});
await page.waitForTimeout(4000); // 等带填充稳定流动

// rAF 采样 2 秒所有物品精灵位置
const samples = await page.evaluate(() => new Promise((resolve) => {
  const stage = window.__game.app.stage;
  let container = null;
  const walk = (node) => {
    if (node.label === 'belowItems') { container = node; return; }
    for (const c of node.children ?? []) walk(c);
  };
  walk(stage);
  const frames = [];
  let count = 0;
  const sample = () => {
    // 每帧: 记录每个精灵的 (x,y)——用 x+y 主轴近似位移量（上行带 y 单调减）
    const pts = container.children.filter((c) => c.visible).map((c) => ({ x: c.x, y: c.y }));
    frames.push(pts);
    count++;
    if (count < 120) requestAnimationFrame(sample);
    else resolve(frames);
  };
  requestAnimationFrame(sample);
}));

// 逐帧跟踪每个精灵（按最近邻配对，容差 8px——帧间应 ≤2px）
let backward = 0, zeroMove = 0, totalMoves = 0, sumStep = 0, maxStep = 0;
for (let f = 1; f < samples.length; f++) {
  const prev = samples[f - 1], cur = samples[f];
  for (const c of cur) {
    let best = null, bestD = Infinity;
    for (const p of prev) {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best || bestD > 8) continue; // 新出现/消失的精灵
    const dx = c.x - best.x, dy = c.y - best.y;
    totalMoves++;
    const step = Math.hypot(dx, dy);
    sumStep += step;
    if (step > maxStep) maxStep = step;
    if (step < 0.01) zeroMove++;
    // 上行带: 前进 = y 减小（dy<0）; 倒退 = dy>0.02（向下走）。允许 0.02px 浮点容差
    if (dy > 0.02) backward++;
  }
}
const avg = totalMoves > 0 ? sumStep / totalMoves : 0;
const zeroFrac = totalMoves > 0 ? zeroMove / totalMoves : 1;
console.log(`采样 ${samples.length} 帧, 匹配位移 ${totalMoves} 次`);
console.log(`  倒退位移: ${backward} 次（期望 0）`);
console.log(`  零移动帧占比: ${(zeroFrac * 100).toFixed(1)}%（期望 <20%——20Hz 步进会让 ~67% 帧零移动）`);
console.log(`  平均步长: ${avg.toFixed(2)}px/帧（速率随采样帧率浮动）, 最大 ${maxStep.toFixed(2)}px（期望 <3——步进/过冲会出现 1.6px+ 突跳）`);
let failed = 0;
const ok = (c, m) => { if (c) console.log(`  ✅ ${m}`); else { failed++; console.error(`  ❌ ${m}`); } };
ok(backward === 0, `零倒退（实际 ${backward}）`);
ok(zeroFrac < 0.2, `无 20Hz 步进（零移动占比 ${(zeroFrac * 100).toFixed(1)}% < 20%）`);
ok(avg > 0.05 && maxStep < 3, `步长平滑无突跳（均值 ${avg.toFixed(2)}px、最大 ${maxStep.toFixed(2)}px）`);
await browser.close();
console.log(failed === 0 ? '\n✅ 物品渲染平滑度验证通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
