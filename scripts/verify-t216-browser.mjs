// T2.16 浏览器验收 — 传送带终点对接辅助（Playwright 驱动系统 Chrome）
// 依据: implementation-phase-2.md T2.16（验收场景: 两炉上下隔一格、拖到 B 正下方一格
//       悬停 → 输入口高亮 + 末段自动朝上；落盘 → "已连接"；并排炉子绕行可见够得着的口；
//       hover 输入口 → "输入端口不能作为起点"提示）
//
// 用法: 先启动 dev server（npm run dev，strictPort 固定 5173），然后:
//       node scripts/verify-t216-browser.mjs
//
// 验收内容（真实 E 键 + 鼠标事件驱动，非脚本搭场）:
//   A 直连: 从下炉输出口起带 → 悬停上炉正下方供给格 → dockInfo 确认端口（绿）→
//     左键落盘 → 段方向指向端口、上炉输入口 ●黄(已连接)
//   B 拖到设备上: 鼠标直接放上炉输入端口格 → 路径自动截断到供给格 + 末段指向端口
//     （旧版此手势整条染红点不了——用户实测"连不上设备"的主路径）
//   C 侧面接近 L 形: 末段默认尾向背离端口 → 吸附覆盖为指向端口，落盘成转角段
//   D 起点反例: hover 态悬停输入端口 → getStartHintCell 命中（红警示+文字），点击无效
//   E 回归: __game.test('t26') 输入对接全流程仍跑通
//
// 截图输出: gui-test-screenshots/t216-*.png
const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const OUT_DIR = 'gui-test-screenshots';
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 15000 });
await page.waitForTimeout(1500); // 等资产/首帧

const shot = (name) => page.screenshot({ path: `${OUT_DIR}/${name}.png` });

/** 世界格中心 → 屏幕坐标（走页面内 camera.worldToScreen，含缩放/旋转）。 */
const cellScreen = async (gx, gy) => {
  const p = await page.evaluate(
    ([x, y]) => window.__game.camera.worldToScreen(x * 64 + 32, y * 64 + 32),
    [gx, gy],
  );
  return p;
};
const moveToCell = async (gx, gy) => {
  const p = await cellScreen(gx, gy);
  await page.mouse.move(p.x, p.y);
};
const clickCell = async (gx, gy) => {
  const p = await cellScreen(gx, gy);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
};
const dockInfo = () => page.evaluate(() => window.__game.belt.getDockInfo());
const startHint = () => page.evaluate(() => window.__game.belt.getStartHintCell());
const beltMode = () => page.evaluate(() => window.__game.belt.getMode());
/** 世界上的传送带段快照 [(x,y,dir,corner)]。 */
const segments = () => page.evaluate(() => {
  const out = [];
  for (const h of window.__game.world.query('BeltSegmentComp', 'Position')) {
    const p = window.__game.world.getComponent(h, 'Position');
    const s = window.__game.world.getComponent(h, 'BeltSegmentComp');
    out.push({ x: Math.round(p.x / 64), y: Math.round(p.y / 64), dir: s.direction, corner: !!s.isCorner });
  }
  return out;
});
/** 指定左上角格的设备的 portStatus 文本。 */
const portStatusAt = (gx, gy) => page.evaluate(([x, y]) => {
  for (const h of window.__game.world.query('BuildingComp', 'Position')) {
    const p = window.__game.world.getComponent(h, 'Position');
    if (Math.round(p.x / 64) === x && Math.round(p.y / 64) === y) {
      return window.__game.portStatus(h);
    }
  }
  return '(未找到设备)';
}, [gx, gy]);

// ── 场景布置: 炉 B（上）与炉 A（下）中间隔一行，放在地图中心附近（保证在视口内）──
const base = await page.evaluate(() => {
  const m = window.__game.worldData.map;
  const cx = Math.floor(m.widthCells / 2);
  const cy = Math.floor(m.heightCells / 2);
  window.__game.clearAllPlaced();
  // B（上）: 输入口朝下，在 (bx..bx+2, by..by+2)；A（下）: 输出口朝上，在 (bx..bx+2, by+4..by+6)
  const bx = cx - 1, by = cy - 3;
  if (!window.__game.placeAt('refining_unit', bx, by)) throw new Error('放置炉 B 失败');
  if (!window.__game.placeAt('refining_unit', bx, by + 4)) throw new Error('放置炉 A 失败');
  return { bx, by };
});
const { bx, by } = base;
const A_OUT = { left: [bx, by + 4], mid: [bx + 1, by + 4], right: [bx + 2, by + 4] };  // A 顶排输出口
const B_IN = { left: [bx, by + 2], mid: [bx + 1, by + 2], right: [bx + 2, by + 2] };   // B 底排输入口
const SUPPLY = { mid: [bx + 1, by + 3], left: [bx, by + 3], side: [bx + 3, by + 2] };  // 供给格
console.log(`[布局] 炉 B(${bx},${by}) 上 / 炉 A(${bx},${by + 4}) 下，隔行 y=${by + 3}；B 输入口 ${JSON.stringify(B_IN)}`);

// ══ A. 直连: 悬停供给格 → 确认反馈 → 落盘 ══
console.log('[A] 悬停 B 正下方供给格 → 末段指向端口（绿确认）→ 左键落盘');
await page.keyboard.press('e'); // 进入创建模式（hover 态）
ok(await beltMode() === 'hover', 'A1. E 键进入创建模式（hover 态）');
await clickCell(...A_OUT.mid); // 选 A 中输出口为起点
ok(await beltMode() === 'preview', 'A2. 点击 A 中输出口选中起点（preview 态）');
await moveToCell(...SUPPLY.mid); // 悬停 B 正下方一格
{
  const di = await dockInfo();
  ok(di !== null && di.confirmed.some((c) => c.x === B_IN.mid[0] && c.y === B_IN.mid[1]),
    `A3. 悬停供给格 → dockInfo.confirmed 命中 B 中输入口 ${JSON.stringify(B_IN.mid)}（端口亮绿"将连接"）`);
  ok(di !== null && di.targets.length === 1, `A4. targets 仅相邻的 1 个输入口（实际 ${JSON.stringify(di?.targets)}）`);
}
await shot('t216-a-confirm-green');
await clickCell(...SUPPLY.mid); // 落盘单格带
{
  const seg = (await segments()).find((s) => s.x === SUPPLY.mid[0] && s.y === SUPPLY.mid[1]);
  ok(seg !== undefined && seg.dir === 270, `A5. 落盘段 (${SUPPLY.mid}) 方向 270(上) 指向端口（实际 ${JSON.stringify(seg)}）`);
  const st = await portStatusAt(bx, by);
  ok(st.includes(`(${B_IN.mid[0]},${B_IN.mid[1]}) ●黄(已连接)`),
    `A6. 落盘后 B 中输入口 已连接（portStatus: ${st.split('\n')[1]?.trim()}）`);
}
await page.keyboard.press('e'); // 退出（toggle: preview→exit）

// ══ B. 拖到设备端口格上（旧版整条染红的卡点）→ 自动截断 + 吸附 ══
console.log('[B] 鼠标直接放到 B 左输入端口格上 → 路径截断到供给格 + 末段指向端口');
await page.keyboard.press('e');
await clickCell(...A_OUT.left); // 从 A 左输出口起带
await moveToCell(...B_IN.left); // 鼠标在 B 左输入端口格（设备格）上
{
  const di = await dockInfo();
  ok(di !== null && di.confirmed.some((c) => c.x === B_IN.left[0] && c.y === B_IN.left[1]),
    'B1. 鼠标在端口格上 → 截断后 confirmed 命中 B 左输入口（预览有效不再染红）');
}
await shot('t216-b-drag-onto-port');
await clickCell(...B_IN.left); // 在设备格上落盘（点击命中供给格语义）
{
  const seg = (await segments()).find((s) => s.x === SUPPLY.left[0] && s.y === SUPPLY.left[1]);
  ok(seg !== undefined && seg.dir === 270, `B2. 落盘段在供给格 (${SUPPLY.left}) 方向 270（实际 ${JSON.stringify(seg)}）`);
  const st = await portStatusAt(bx, by);
  ok(st.includes(`(${B_IN.left[0]},${B_IN.left[1]}) ●黄(已连接)`),
    `B3. B 左输入口 已连接（portStatus: ${st.split('\n')[1]?.trim()}）`);
}
await page.keyboard.press('e');

// ══ C. 侧面接近: L 形末段默认尾向背离端口 → 吸附覆盖 + 转角段 ══
console.log('[C] 从右侧绕行接近 B 右输入口 → 末段默认朝上，吸附覆盖为朝左指向端口');
await page.keyboard.press('e');
await clickCell(...A_OUT.right); // 从 A 右输出口起带（首步强制向上）
await moveToCell(bx + 3, by + 3); // L 形中段（无端口相邻）
{
  const di = await dockInfo();
  ok(di !== null && di.targets.length === 0, `C1. 绕行中段 targets 空（未到对接位，实际 ${JSON.stringify(di?.targets)}）`);
}
await moveToCell(...SUPPLY.side); // B 右输入口右侧一格
{
  const di = await dockInfo();
  ok(di !== null && di.confirmed.some((c) => c.x === B_IN.right[0] && c.y === B_IN.right[1]),
    'C2. 悬停端口右侧供给格 → confirmed 命中 B 右输入口（末段被吸附为朝左）');
}
await shot('t216-c-side-snap');
await clickCell(...SUPPLY.side);
{
  const seg = (await segments()).find((s) => s.x === SUPPLY.side[0] && s.y === SUPPLY.side[1]);
  ok(seg !== undefined && seg.dir === 180 && seg.corner,
    `C3. 落盘段 (${SUPPLY.side}) 方向 180(左) 且为转角段（实际 ${JSON.stringify(seg)}）`);
  const st = await portStatusAt(bx, by);
  ok(st.includes(`(${B_IN.right[0]},${B_IN.right[1]}) ●黄(已连接)`),
    `C4. B 右输入口 已连接（portStatus: ${st.split('\n')[1]?.trim()}）`);
}
await page.keyboard.press('e');

// ══ D. 起点反例: hover 态悬停输入端口 → 反例提示 + 点击无效 ══
console.log('[D] hover 态悬停 B 中输入端口格 → 起点反例提示，点击不选起点');
await page.keyboard.press('e'); // 进入 hover 态
await moveToCell(...B_IN.mid);
{
  const hint = await startHint();
  ok(hint !== null && hint.x === B_IN.mid[0] && hint.y === B_IN.mid[1],
    `D1. 悬停输入端口 → getStartHintCell 命中 ${JSON.stringify(B_IN.mid)}（红警示 + 文字"输入端口不能作为起点"）`);
}
await shot('t216-d-start-hint');
await clickCell(...B_IN.mid);
ok(await beltMode() === 'hover', 'D2. 点击输入端口不选起点（仍是 hover 态，替代旧版静默无效）');
await moveToCell(bx + 1, by + 3); // 移开 → 提示消失
{
  const hint = await startHint();
  ok(hint === null, 'D3. 移开鼠标 → 提示消失');
}
await page.keyboard.press('e'); // 退出创建模式

// ══ E. 回归: t26 输入对接一键测试（预约制吸入/满槽堵停/疏通）仍全绿 ══
console.log('[E] 回归: __game.test("t26") 输入对接全流程');
{
  const result = await page.evaluate(() => window.__game.test('t26'));
  ok(typeof result === 'string' && result.includes('一键测试完成'),
    `E1. t26 一键测试跑通（结果: ${result}）`);
}

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
