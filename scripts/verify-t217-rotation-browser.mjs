// T2.17 浏览器验收 — 仓库口四向旋转（90°/270° 占地宽高互换 3×1 ↔ 1×3）
// 依据: implementation-phase-2.md T2.17、buildings.ts effectiveFootprint（旋转几何单一事实源）
//
// 用法: 先启动 dev server（npm run dev），然后:
//       node scripts/verify-t217-rotation-browser.mjs
//
// 验收内容（__game 程序化放置 + 只读断言，渲染/选中框走截图人工核验）:
//   A 占地互换: 取货口 90° 落盘占用竖条 1×3（10,10)~(10,12)，不再是横条 3×1
//   B 占用检查: canPlace 按有效占地——90° 竖放贴地图下缘越界拒绝、同位置 0° 横放可放
//   C 旋转态物流: 90° 取货口中口功能面朝右接出带 → 90° 存货口中口功能面朝左供给，
//     端到端物品流动（depot-output / depot-input 事件持续产生）
//   C2 T2.18: 两侧格不是端口——侧格旁的带永无物品、中口对照正常出货
//   D 删除释放: 竖放置货口删除 → 1×3 三格全部释放（releaseFootprint 有效占地同源）
//   E 渲染: 竖放设备外观 + 选中框与竖条占地重合（截图人工核验）
//
// 截图输出: gui-test-screenshots/t217-*.png
const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const OUT_DIR = 'gui-test-screenshots';

const { chromium } = await import(PW_URL);
import { mkdirSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
};

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 15000 });
await page.waitForTimeout(1500); // 等资产/首帧

const shot = (name) => page.screenshot({ path: `${OUT_DIR}/${name}.png` });

// ══ A+B+D: 占地互换 / 占用检查 / 删除释放（页面内程序化断言）══
console.log('[A/B/D] 占地互换 + 占用检查 + 删除释放');
const abd = await page.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  g.clearAllPlaced();
  await sleep(200);
  const cells = () => g.getOccupiedCells().map((c) => `${c.gx},${c.gy}`).sort();
  const out = { checks: [] };
  const check = (name, cond, detail = '') => out.checks.push({ name, cond: !!cond, detail });

  // A 占地互换: 90° 落盘 → 竖条 1×3
  check('A1 取货口 90° 放置成功', g.placeAt('depot_unloader', 10, 10, 90));
  check(
    'A2 占用 = (10,10)(10,11)(10,12) 竖条 1×3',
    JSON.stringify(cells()) === JSON.stringify(['10,10', '10,11', '10,12']),
    cells().join(' '),
  );

  // B 占用检查按有效占地: 地图 64×64，(63,62) 竖放需 gy 62~64 → 越界拒绝
  check('B1 90° 竖放越界拒绝', g.placeAt('depot_unloader', 63, 62, 90, true) === false);
  check('B2 同区域 0° 横放可放', g.placeAt('depot_unloader', 61, 63, 0, true) === true);

  // D 删除释放（放在 C 物流前先删，避免 B2 的闲置取货口干扰事件统计）
  check('D1 选中首台（(10,10) 竖放取货口）', g.selectFirstBuilding());
  check('D2 删除成功', g.deleteSelectedBuilding());
  const after = cells();
  check(
    'D3 竖条三格全部释放',
    !after.includes('10,10') && !after.includes('10,11') && !after.includes('10,12'),
    after.join(' '),
  );
  return out;
});
for (const c of abd.checks) ok(c.cond, `${c.name}${c.detail ? `（${c.detail}）` : ''}`);

// ══ C: 旋转态端到端物流（90° 取货口 → 向右带 → 90° 存货口）══
console.log('[C] 旋转态物流: 90° 取货口 → 右向带 → 90° 存货口');
const cRes = await page.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  g.clearAllPlaced();
  await sleep(200);
  const out = { checks: [], outN: 0, inN: 0 };
  const check = (name, cond, detail = '') => out.checks.push({ name, cond: !!cond, detail });
  // 取货口 (10,10) 90°: 占地 (10,10)~(10,12)，唯一端口=中间格 (10,11)，功能面朝右
  check('C1 取货口 90° 放置', g.placeAt('depot_unloader', 10, 10, 90));
  // 存货口 (16,10) 270°: 占地 (16,10)~(16,12)，唯一端口=中间格 (16,11)；
  // T2.19 输入口基准朝上 → 270° 时功能面朝左，供给格 (15,11)
  check('C2 存货口 270° 放置', g.placeAt('depot_loader', 16, 10, 270));
  // 向右带 (11,11)→(15,11) 逐格枚举（spawnBelt 按路径点建段，不插值）:
  // 末段 (15,11) 指向存货口中口 (16,11) 的供给格
  check('C3 铺带 5 格向右', g.spawnBelt([[11, 11], [12, 11], [13, 11], [14, 11], [15, 11]], 0) === 5);
  // 首件走完 5 格 ≈ 10s（0.5 格/秒），轮询 20s 上限等进料事件
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    await sleep(1000);
    out.inN = g.productionLog().filter((e) => e.type === 'depot-input').length;
    if (out.inN >= 1) break;
  }
  out.outN = g.productionLog().filter((e) => e.type === 'depot-output').length;
  check('C4 取货口出货 ≥ 2 件', out.outN >= 2, `out=${out.outN}`);
  check('C5 存货口进料 ≥ 1 件', out.inN >= 1, `in=${out.inN}`);
  return out;
});
for (const c of cRes.checks) ok(c.cond, `${c.name}${c.detail ? `（${c.detail}）` : ''}`);

// ══ C2: T2.18 侧格非端口（侧格旁的带永无物品）══
console.log('[C2] T2.18: 两侧格不是端口，不能起带/连接');
const side = await page.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  g.clearAllPlaced();
  await sleep(200);
  const out = { checks: [] };
  const check = (name, cond, detail = '') => out.checks.push({ name, cond: !!cond, detail });
  // 取货口 (20,20) 0°: 唯一端口=中间格 (21,20) 朝上；侧格 (20,20)/(22,20)
  check('S1 取货口 0° 放置', g.placeAt('depot_unloader', 20, 20, 0));
  // 侧格上方各铺一条带（旧版三口时这里能接到货，T2.18 起不能）
  check('S2 侧格上方铺带', g.spawnBelt([[20, 19], [22, 19]], 0) === 2);
  // 中口上方铺 1 格带作对照（应持续收到货）
  check('S3 中口上方铺带', g.spawnBelt([[21, 19]], 270) === 1);
  await sleep(6000);
  const itemsAt = (x, y) => {
    for (const h of g.world.query('BeltSegmentComp', 'Position')) {
      const p = g.world.getComponent(h, 'Position');
      if (Math.round(p.x / 64) === x && Math.round(p.y / 64) === y) {
        return g.world.getComponent(h, 'BeltSegmentComp').items.length;
      }
    }
    return -1;
  };
  const sideN = [itemsAt(20, 19), itemsAt(22, 19)];
  const midN = itemsAt(21, 19);
  check('S4 侧格旁的带 6 秒后仍无物品（侧格非端口）', sideN.every((n) => n === 0), `side=${sideN}`);
  check('S5 对照: 中口上方带有物品（端口正常出货）', midN >= 1, `mid=${midN}`);
  return out;
});
for (const c of side.checks) ok(c.cond, `${c.name}${c.detail ? `（${c.detail}）` : ''}`);

// ══ E: 渲染人工核验截图（竖放外观 + 选中框重合 + 旋转预览）══
console.log('[E] 渲染截图（人工核验）');
await page.evaluate(() => {
  const g = window.__game;
  g.clearAllPlaced();
  g.placeAt('depot_unloader', 28, 30, 90); // 相机默认中心附近竖放
  g.placeAt('depot_loader', 30, 30, 270);  // 反向竖放（功能面朝右）
});
await page.waitForTimeout(500);
await shot('t217-e1-vertical-placed');
await page.evaluate(() => window.__game.selectFirstBuilding());
await page.waitForTimeout(300);
await shot('t217-e2-vertical-selection-box');
// 放置预览四档旋转: 选取货口 → R 四次各截一帧
await page.keyboard.press('Escape');
await page.mouse.click(748, 660); // 工具栏 b4 仓库取货口（InventoryUI 布局同 t212 脚本）
await page.mouse.move(900, 300, { steps: 4 });
for (const [i, name] of ['r0', 'r90', 'r180', 'r270'].entries()) {
  if (i > 0) await page.keyboard.press('r');
  await page.waitForTimeout(250);
  await shot(`t217-e3-preview-${name}`);
}
await page.keyboard.press('Escape');
await page.evaluate(() => window.__game.clearAllPlaced());
await browser.close();

console.log(`\n${passed} 通过, ${failed} 失败（另有 6 张截图人工核验 t217-e*）`);
if (failed > 0) {
  console.error('❌ T2.17 浏览器验收失败');
  process.exit(1);
}
console.log('✅ T2.17 浏览器验收通过');
