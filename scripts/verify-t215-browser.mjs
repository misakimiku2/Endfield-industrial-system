// T2.15 设备详情弹窗 浏览器验收 — 真实玩家输入流（Playwright 驱动系统 Chrome）
// 依据: doc/implementation-phase-2.md T2.15（Phase 2 首版裁剪范围）
//
// 用法: 先启动 dev server（npm run dev），然后:
//       node scripts/verify-t215-browser.mjs
//
// 验收内容（全程真实鼠标/键盘；__game 只做只读断言与程序化放置）:
//   A 外壳+信息栏: 点击已放置设备 → 深色弹窗弹出，信息栏含 设备名/耗电功率值/关闭按钮（截图）
//   B 电源开关: 点「关」→ productionStatus 含"已暂停"（T2.8 LOGO 联动）；点「开」→ 恢复（截图）
//   C 生产状态摘要: 注入源矿 → 输入格计数出现；进度条实时推进（100ms 刷新）
//   D 关闭途径: 点遮罩关闭 → 弹窗隐藏 + 选中清空；再点设备可重开
//   E 取货口产出选择: 「添加物品」→ 选择面板 → 选矿物类物品 → 取货口实际输出该物品到传送带（端到端）
//   F 删除按钮: 存货口弹窗点「删除」→ 实体销毁 + 占用释放 + 弹窗关闭
//
// 截图输出: gui-test-screenshots/t215-*.png
const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const OUT_DIR = 'gui-test-screenshots';

const { chromium } = await import(PW_URL);
import { mkdirSync } from 'node:fs';
mkdirSync(OUT_DIR, { recursive: true });

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); };
};

// ── 屏幕坐标（viewport 1280×720，相机默认 (2048,2048) zoom1 rot0）──
const S = {
  toolbarY: 660,
  btnFurnace: 460,
  furnace: { x: 928, y: 392 },   // 网格(35,31) 3×3 中心
};
const dialogVisible = () => page.evaluate(() => {
  const root = document.querySelector('.efd-dialog-root');
  return root !== null && root.hidden === false;
});

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 15000 });
await page.waitForTimeout(1500); // 等资产/首帧

const shot = (name) => page.screenshot({ path: `${OUT_DIR}/${name}.png` });
const game = (fn, arg) => page.evaluate(fn, arg);

// ══ A. 外壳 + 信息栏 ══
console.log('[A] 点击设备 → 弹窗弹出（信息栏: 名称/耗电/关闭）');
await game(() => window.__game.clearAllPlaced());
await page.mouse.click(S.btnFurnace, S.toolbarY);   // 工具栏选精炼炉
await page.mouse.move(S.furnace.x, S.furnace.y, { steps: 4 });
await page.mouse.click(S.furnace.x, S.furnace.y);   // 放置（放置点击不开弹窗）
await page.keyboard.press('Escape');                 // 退出放置模式
await page.waitForTimeout(300);
const noDialogOnPlace = await game(() => !window.__game.deviceDialog.isOpen());
ok(noDialogOnPlace, 'A1. 放置点击不触发弹窗（弹窗只跟随选中）');
await page.mouse.click(S.furnace.x, S.furnace.y);   // 选中 → 弹窗
await page.waitForTimeout(400);                      // 等 100ms 刷新 + 图标
ok(await dialogVisible(), 'A2. 点击已放置设备 → 弹窗打开');
const infoBar = await game(() => {
  const t = (sel) => document.querySelector(sel)?.textContent ?? '';
  return { name: t('.efd-infobar-name'), power: t('.efd-infobar-power') };
});
ok(infoBar.name === '精炼炉', `A3. 信息栏显示设备名（实际: ${infoBar.name}）`);
ok(infoBar.power === '耗电功率值：5W', `A4. 信息栏显示耗电功率（实际: ${infoBar.power}）`);
await shot('t215-a-dialog-furnace');

// ══ B. 电源开关（暂停正式入口）══
console.log('[B] 电源开关: 关 → 暂停（LOGO 联动），开 → 恢复');
await game(() => window.__game.injectInput('originium_ore', 5));
await page.waitForFunction(() => {
  const c = window.__game.world.getComponent(
    window.__game.world.query('BuildingComp')[0], 'BuildingComp');
  return c?.state === 'working';
}, null, { timeout: 8000 });
const switchOn = await page.evaluate(() =>
  document.querySelector('.efd-power-switch')?.classList.contains('is-on') ?? false);
ok(switchOn, 'B1. 生产中开关初始为「开」');
await page.click('.efd-power-switch-tab.off');
await page.waitForTimeout(250);
const pausedNow = await game(() => window.__game.productionStatus().includes('已暂停'));
const switchOff = await page.evaluate(() =>
  document.querySelector('.efd-power-switch')?.classList.contains('is-off') ?? false);
ok(pausedNow && switchOff, 'B2. 点「关」→ comp.paused=true（productionStatus 含"已暂停"，滑块红色在右）');
await shot('t215-b-paused');
const frozenP = await game(() => window.__game.world.getComponent(
  window.__game.world.query('BuildingComp')[0], 'BuildingComp').progress);
await page.waitForTimeout(1200);
const stillP = await game(() => window.__game.world.getComponent(
  window.__game.world.query('BuildingComp')[0], 'BuildingComp').progress);
ok(frozenP === stillP, `B3. 暂停期间进度冻结（${(frozenP * 100).toFixed(1)}% → ${(stillP * 100).toFixed(1)}%）`);
await page.click('.efd-power-switch-tab.on');
await page.waitForTimeout(300);
const resumed = await game(() => !window.__game.productionStatus().includes('已暂停'));
ok(resumed, 'B4. 点「开」→ 恢复（从暂停处继续）');

// ══ C. 生产状态摘要（吸收 T2.9b 读数）══
console.log('[C] 状态摘要: 缓冲数量在格上 + 进度条推进');
const inCount = await page.evaluate(() =>
  document.querySelector('.efd-tile-slots .efd-tile-count')?.textContent ?? '');
ok(inCount.includes('/50'), `C1. 输入格显示计数（实际: ${inCount}）`);
const progressMoved = await page.waitForFunction(() => {
  const w = document.querySelector('.efd-progress-fill')?.style.width ?? '';
  return parseInt(w, 10) > 0;
}, null, { timeout: 6000 }).then(() => true).catch(() => false);
ok(progressMoved, 'C2. 进度条实时推进（100ms 局部刷新）');
await shot('t215-c-production');

// ══ D. 关闭途径 ══
console.log('[D] 遮罩点击关闭 + 重开');
await page.mouse.click(5, 5); // 遮罩（弹窗 720 高铺满视口前留有遮罩边缘？视口 720 → 弹窗铺满，改用键盘 ESC）
await page.waitForTimeout(250);
const closedByBlank = await game(() => !window.__game.deviceDialog.isOpen());
if (!closedByBlank) {
  // 1280×720 视口下弹窗铺满全屏（无遮罩可点）→ 用 ESC 路径验收
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}
ok(await game(() => !window.__game.deviceDialog.isOpen()), 'D1. 关闭途径生效（遮罩/ESC）');
const selCleared = await game(() => window.__game.selection.getSelected() === null);
ok(selCleared, 'D2. 关闭弹窗后选中清空（双向绑定）');
await page.mouse.click(S.furnace.x, S.furnace.y);
await page.waitForTimeout(300);
ok(await dialogVisible(), 'D3. 再点设备 → 弹窗重开');
await page.keyboard.press('Escape'); // 留干净现场给 E 节
await page.waitForTimeout(200);

// ══ E. 取货口产出选择（配置 → 实际输出端到端）══
console.log('[E] 取货口产出物品选择（弹窗 → MachineSystem 端到端）');
await game(() => {
  window.__game.clearAllPlaced();
  window.__game.placeAt('depot_unloader', 30, 32, 0);   // 0°: 输出口(31,32) 朝上
  window.__game.placeAt('depot_loader', 30, 27, 180);   // 180°: 接带面朝下，供给带 (31,28) 指入
  window.__game.spawnBelt([[31, 31], [31, 30], [31, 29], [31, 28]], 270);
});
await game(() => window.__game.selectFirstBuilding()); // 第一台 = 取货口
await page.waitForTimeout(400);
ok(await dialogVisible(), 'E1. 选中取货口 → 弹窗（仓库口面板）');
const card0 = await page.evaluate(() =>
  document.querySelector('.efd-warehouse-card-name')?.textContent ?? '');
ok(card0 === '源矿', `E2. 默认产出源矿（卡片名: ${card0}）`);
await page.click('.efd-capsule-btn');                    // 添加物品
await page.waitForTimeout(300);
const pickerShown = await page.evaluate(() => {
  const p = document.querySelector('.efd-picker');
  return p !== null && p.hidden === false;
});
ok(pickerShown, 'E3. 「添加物品」→ 产出选择面板出现');
await page.click('.efd-picker-tab:nth-child(3)');        // 矿物（第 1 个 tab 按钮之前是 pill div）
await page.waitForTimeout(300);
await shot('t215-e-picker');
await page.click('.efd-picker-grid .efd-picker-tile');   // 选矿物类第一件
await page.waitForTimeout(300);
const picked = await game(() => {
  const h = window.__game.world.query('BuildingComp')[0];
  return window.__game.world.getComponent(h, 'BuildingComp').depotOutputItemId;
});
const pickedName = await game(() => {
  const h = window.__game.world.query('BuildingComp')[0];
  const id = window.__game.world.getComponent(h, 'BuildingComp').depotOutputItemId;
  return window.__game.itemTable.byId.get(id)?.name ?? id;
});
ok(picked !== null && picked !== 'originium_ore', `E4. 选择写入实例字段 depotOutputItemId=${picked}（${pickedName}）`);
// 端到端: 取货口应开始输出所选物品（1件/2秒）
const flows = await page.waitForFunction((name) =>
  window.__game.productionLog().filter((e) => e.type === 'depot-output').length >= 1
  && window.__game.beltStatus().includes(name),
pickedName, { timeout: 20000 }).then(() => true).catch(() => false);
ok(flows, `E5. 取货口实际输出所选物品「${pickedName}」上带（MachineSystem 按实例字段出货）`);
await page.mouse.click(5, 5);
await page.waitForTimeout(250);
if (await dialogVisible()) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
await shot('t215-e2-flow');

// ══ F. 删除按钮（对接 T1.9）══
console.log('[F] 弹窗删除按钮');
await game(() => {
  window.__game.clearAllPlaced();
  window.__game.placeAt('depot_loader', 30, 31, 0);
  window.__game.selectFirstBuilding();
});
await page.waitForTimeout(400);
ok(await dialogVisible(), 'F1. 选中存货口 → 弹窗（只读面板）');
const loaderName = await page.evaluate(() =>
  document.querySelector('.efd-infobar-name')?.textContent ?? '');
ok(loaderName === '仓库存货口', `F2. 信息栏为存货口且无耗电段（${loaderName}）`);
await page.click('.efd-action-btn');
await page.waitForTimeout(400);
const goneAndClosed = await game(() =>
  window.__game.world.query('BuildingComp').length === 0 && !window.__game.deviceDialog.isOpen());
ok(goneAndClosed, 'F3. 点「删除」→ 实体销毁 + 弹窗关闭');
const occEmpty = await game(() => window.__game.getOccupiedCells().length === 0);
ok(occEmpty, 'F4. 占用表已释放（无占位泄漏）');

await page.waitForTimeout(300);
await shot('t215-final');
await browser.close();

console.log(`\n${passed} 通过, ${failed} 失败（另有截图人工核验: t215-a/b/c/e*）`);
if (failed > 0) {
  console.error('❌ T2.15 设备弹窗浏览器验收失败');
  process.exit(1);
}
console.log('✅ T2.15 设备弹窗浏览器验收通过');
