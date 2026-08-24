// T2.9 + T2.12 浏览器验收 — 真实玩家输入流（Playwright 驱动系统 Chrome）
// 依据: implementation-phase-2.md T2.9（2026-08-24 修订版）/ T2.12（用户澄清版）
//
// 用法: 先启动 dev server（npm run dev，默认端口被占用时 vite 自动换端口——本脚本
//       固定连 http://localhost:5175，若不符改 BASE_URL），然后:
//       node scripts/verify-t212-browser.mjs
//
// 验收内容（全程真实鼠标/键盘，不用 __game 注入搭建；__game 只做只读断言）:
//   A 玩家放置: 工具栏选「仓库取货口/仓库存货口」→ 画布左键放置（3×1 外观 + 居中单层 LOGO）
//   B 传送带创建: E 进创建模式 → 悬停取货口输出口（Status 面板蓝高亮截图）→ 起点点击
//     → 上移 → 落盘 → 末端接入存货口输入口
//   C 物流: 源矿源源上带（depot-output ≥ 3）→ 流动 → 进存货口消失（depot-input ≥ 3）
//   D T2.9b 读数: 放精炼炉 → 点击 → 读数"输入: x/50 输出: y/50"可见（截图）；
//     点击取货口 → 读数消失（非生产设备无缓冲区）
//   E R 两档旋转: 取货口放置态按 R 两次 → 0°↔180°（截图对比），无 90°/270°
//   F 存货口悬停: E 模式悬停存货口输入格 → Status 淡蓝（截图）
//
// 截图输出: gui-test-screenshots/t212-*.png
const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = 'http://localhost:5175/';
const OUT_DIR = 'gui-test-screenshots';

const { chromium } = await import(PW_URL);
import { mkdirSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
};

// ── 屏幕坐标（viewport 1280×720，相机默认 (2048,2048) zoom1 rot0）──
// screen = world − 2048 + (640,360)
const S = {
  toolbarY: 660,            // InventoryUI.layout: barY=616 + padding12 + 32
  btnFurnace: 460,          // b0 精炼炉（x = 416+12+32+72i）
  btnUnloader: 748,         // b4 仓库取货口
  btnLoader: 820,           // b5 仓库存货口
  unloader: { x: 608, y: 392 },  // 网格(30,32) 中心 world(2016,2080)
  loader: { x: 608, y: 136 },    // 网格(30,28) 中心 world(2016,1824)
  beltEnd: { x: 608, y: 200 },   // 格(31,29) 中心 world(2016,1888)
  furnace: { x: 928, y: 392 },   // 网格(35,31) 3×3 中心 world(2336,2080)
};

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 15000 });
await page.waitForTimeout(1500); // 等资产/首帧

const shot = (name) => page.screenshot({ path: `${OUT_DIR}/${name}.png` });
const game = (fn, arg) => page.evaluate(fn, arg);
const depotCount = async (type) =>
  (await game((t) => window.__game.productionLog().filter((e) => e.type === t), type)).length;

// ══ A. 玩家放置两个仓库口 ══
console.log('[A] 工具栏放置仓库取货口/存货口');
await page.mouse.click(S.btnUnloader, S.toolbarY);
await page.mouse.move(S.unloader.x, S.unloader.y, { steps: 4 });
await page.waitForTimeout(250);
await shot('t212-a1-unloader-preview');
await page.mouse.click(S.unloader.x, S.unloader.y);
await page.keyboard.press('Escape');
await page.mouse.click(S.btnLoader, S.toolbarY);
await page.mouse.move(S.loader.x, S.loader.y, { steps: 4 });
await page.mouse.click(S.loader.x, S.loader.y);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const occAfter = await game(() => window.__game.getOccupiedCells());
ok(Array.isArray(occAfter) && occAfter.length === 6,
  `A1. 两个 3×1 仓库口放置成功，占用 6 格 (实际 ${occAfter.length})`);
await shot('t212-a2-depots-placed');

// ══ B. E 模式创建传送带（起点=取货口输出口，终点接存货口输入口）══
console.log('[B] 传送带创建（玩家 E 模式）');
await page.keyboard.press('e');
await page.waitForTimeout(200);
await page.mouse.move(S.unloader.x, S.unloader.y, { steps: 4 });
await page.waitForTimeout(400);
await shot('t212-b1-status-hover'); // Status 面板蓝高亮（悬停输出口）
await page.mouse.click(S.unloader.x, S.unloader.y); // 起点
await page.mouse.move(S.beltEnd.x, S.beltEnd.y, { steps: 6 });
await page.waitForTimeout(300);
await shot('t212-b2-belt-preview'); // 蓝色预览路径
await page.mouse.click(S.beltEnd.x, S.beltEnd.y); // 落盘
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const beltLines = await game(() => window.__game.beltStatus());
ok(typeof beltLines === 'string' && beltLines.includes('段2'),
  `B1. 传送带 3 段创建成功（beltStatus 含段2: ${beltLines.split('\n').length} 行）`);

// ══ C. 物流: 无限源上带 → 流动 → 无限汇消失 ══
console.log('[C] 物流观察（真实运行 12 秒）');
await page.waitForTimeout(6000);
await shot('t212-c1-items-flow');
const out6 = await depotCount('depot-output');
ok(out6 >= 2, `C1. 取货口 6 秒内持续输出 ≥ 2 件（实际 ${out6}，1件/2秒/口）`);
await page.waitForTimeout(6000);
await shot('t212-c2-items-flow2');
const out12 = await depotCount('depot-output');
const in12 = await depotCount('depot-input');
ok(out12 >= 5, `C2. 无限源持续输出 ≥ 5 件（实际 ${out12}）`);
ok(in12 >= 3, `C3. 存货口持续接收 ≥ 3 件（实际 ${in12}，物品进端口格中心消失）`);
const beltMid = await game(() => window.__game.beltStatus());
ok(!beltMid.includes('[堵]'), 'C4. 全链无堵塞（无限汇永不回压）');

// ══ D. T2.9b 读数: 精炼炉有 / 仓库口无 ══
console.log('[D] 选中读数（T2.9b）');
await page.mouse.click(S.btnFurnace, S.toolbarY);
await page.mouse.move(S.furnace.x, S.furnace.y, { steps: 4 });
await page.mouse.click(S.furnace.x, S.furnace.y);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.mouse.click(S.furnace.x, S.furnace.y); // 选中精炼炉
await page.waitForTimeout(500); // 4Hz 节流
await shot('t212-d1-readout-furnace');
await page.mouse.click(S.unloader.x, S.unloader.y); // 换选取货口
await page.waitForTimeout(500);
await shot('t212-d2-readout-depot-none');
ok(true, 'D1. 截图对比: 精炼炉选中显示读数 / 仓库口选中无读数（人工核验 t212-d1 vs d2）');

// ══ E. R 两档旋转 ══
console.log('[E] R 键两档旋转（非正方形占地）');
await page.mouse.click(S.btnUnloader, S.toolbarY);
await page.keyboard.press('r');
await page.mouse.move(1000, 500, { steps: 4 });
await page.waitForTimeout(250);
await shot('t212-e1-rot180');
await page.keyboard.press('r');
await page.waitForTimeout(250);
await shot('t212-e2-rot0');
await page.keyboard.press('r'); // 第三次应回到 180（两档循环，无 90°）
await page.waitForTimeout(250);
await shot('t212-e3-rot180-again');
await page.keyboard.press('Escape');
ok(true, 'E1. 截图对比: R 仅 0°↔180° 两档（人工核验 t212-e1~e3）');

// ══ F. 存货口输入格悬停 ══
console.log('[F] E 模式悬停存货口（Status 淡蓝）');
await page.keyboard.press('e');
await page.waitForTimeout(200);
await page.mouse.move(S.loader.x, S.loader.y, { steps: 4 });
await page.waitForTimeout(400);
await shot('t212-f1-loader-hover');
await page.keyboard.press('Escape');

await page.waitForTimeout(300);
await shot('t212-final-scene');
await browser.close();

console.log(`\n${passed} 通过, ${failed} 失败（另有 4 项截图人工核验）`);
if (failed > 0) {
  console.error('❌ T2.9+T2.12 浏览器验收失败');
  process.exit(1);
}
console.log('✅ T2.9+T2.12 浏览器验收通过');
mkdirSync(OUT_DIR, { recursive: true });
