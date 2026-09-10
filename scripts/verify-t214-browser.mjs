// T2.14 设备移动 浏览器验收 — 真实玩家输入流（Playwright 驱动系统 Chrome）
// 依据: doc/implementation-phase-2.md T2.14（长按拾取 + R 旋转 + 左键重放 / 右键·ESC 取消）
//
// 用法: 先启动 dev server（npm run dev），然后:
//       node scripts/verify-t214-browser.mjs
//
// 验收内容（全程真实鼠标/键盘；__game 只做只读断言与程序化放置）:
//   A 长按拾取: 按住设备 >300ms（未松开）→ 进入移动态 + 真身隐藏 + 原占位释放（截图）
//   B R 旋转: 移动态按 R → 预览朝向 +90（四档），Port 朝向跟随（worldAngle 采样断言）
//   C 左键重放: 空白处左键 → 设备按新朝向落盘（Position/direction/占位表更新）
//   D 放置失败: 拖到另一台设备上左键 → 预览红(valid=false) + 震动 + 保持在移动态（截图）
//   E 取消: 右键 / ESC → 设备回原位原朝向，占用表与初始一致
//   F 短按不冲突: 短按(<300ms) = 仅选中（弹窗弹出），不进入移动态
//   G 运行时状态保留: 带半成品进度的设备搬迁后 progress/elapsed/缓冲区保留并继续生产
//   H 弹窗「移动」按钮: 点按钮 → 弹窗关闭 + 对该设备进入移动态
//   I 非正方形占地: 取货口 3×1 旋转 90° 后按 1×3 有效占地落盘（T2.17 宽高互换）
//   J 占位无泄漏: 多次移动/取消后占用表 Cell 数与设备占地总数一致
//
// ⚠️ 教训（首版脚本翻车）: 相机边缘滚动区为屏幕四边 32px——测试点位必须远离边缘
//   （首版 y=8 的点击点让相机以 900px/s 上漂，后续全部屏幕坐标错位），每节开始前
//   复位相机 + 把鼠标停靠屏幕中位，避免截图/等待期间边缘滚动累积漂移。
//
// 截图输出: gui-test-screenshots/t214-*.png
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
// screen = world − (1408, 1688)；world = (cell + 尺寸/2) × 64。所有点位离四边 ≥80px。
const cellToScreen = (gx, gy, w = 1, h = 1) => ({
  x: Math.round((gx + w / 2) * 64 - 1408),
  y: Math.round((gy + h / 2) * 64 - 1688),
});
// placementFromMouse 逆运算: 鼠标屏幕坐标 → 有效占地左上角 grid
const screenToGrid = (sx, sy, effW, effH) => ({
  gx: Math.round(((sx + 1408) - (effW * 64) / 2) / 64),
  gy: Math.round(((sy + 1688) - (effH * 64) / 2) / 64),
});
const PARK = { x: 640, y: 400 }; // 鼠标停靠位（屏幕中位，远离边缘滚动区）

const S = {
  furnaceA: cellToScreen(35, 30, 3, 3),   // 设备 A: 精炼炉 3×3 @ (35,30) → (928,328)
  furnaceB: cellToScreen(39, 30, 3, 3),   // 设备 B: 精炼炉 3×3 @ (39,30) → (1184,328)（D 阻挡物）
  targetFree: cellToScreen(34, 27, 3, 3), // C 重放目标: (34,27) 3×3 空地 → (864,136)
  depotV: cellToScreen(40, 32, 1, 3),     // I 目标: 1×3 竖放 (40,32..34) → (1184,456)
};

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 15000 });
await page.waitForTimeout(1500); // 等资产/首帧

const shot = async (name) => {
  await page.mouse.move(PARK.x, PARK.y, { steps: 2 }); // 停靠中位: 截图期间无边缘滚动
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${OUT_DIR}/${name}.png` });
};
const game = (fn, arg) => page.evaluate(fn, arg);
/** 复位相机到默认 (2048,2048) zoom1（消除上一节可能的边缘漂移）。 */
const resetCamera = () => game(() => {
  const c = window.__game.camera;
  c.x = 2048; c.y = 2048; c.zoom = 1;
  c.updateTransform();
});
/** 每节开始: 相机复位 + 鼠标停靠中位（等一帧让边缘滚动停止）。 */
const sectionReset = async () => {
  await page.mouse.move(PARK.x, PARK.y, { steps: 2 });
  await resetCamera();
  await page.waitForTimeout(150);
};

// __game 快捷访问（只读断言 + 程序化放置）
const clearAll = () => game(() => window.__game.clearAllPlaced());
const place = (defId, gx, gy, dir = 0) => game(
  ([d, x, y, r]) => window.__game.placeAt(d, x, y, r), [defId, gx, gy, dir],
);
const occupiedCells = () => game(() => window.__game.getOccupiedCells());
const moving = () => game(() => window.__game.move.isMoving());
const movingHandle = () => game(() => window.__game.move.getMovingHandle());
const previewInfo = () => game(() => window.__game.move.getPreviewInfo());
const firstHandle = () => game(() => {
  const hs = window.__game.world.query('BuildingComp');
  return hs.length > 0 ? hs[0] : null;
});
const lastHandle = () => game(() => {
  const hs = window.__game.world.query('BuildingComp');
  return hs.length > 0 ? hs[hs.length - 1] : null;
});
const posOf = (h) => game(
  (h) => { const p = window.__game.world.getComponent(h, 'Position'); return { x: p.x, y: p.y }; }, h,
);
const dirOf = (h) => game(
  (h) => window.__game.world.getComponent(h, 'BuildingComp').direction, h,
);
const compOf = (h) => game(
  (h) => {
    const c = window.__game.world.getComponent(h, 'BuildingComp');
    return {
      paused: c.paused,
      progress: c.progress,
      elapsed: c.elapsed,
      state: c.state,
      input0: c.bufferInput[0]?.count ?? 0,
      output0: c.bufferOutput[0]?.count ?? 0,
    };
  }, h,
);

// 长按拾取: 按住 holdMs 后断言（此时按钮仍按着，验证"长按即拾取"），再松开
const longPress = async (sx, sy, holdMs = 500) => {
  await page.mouse.move(sx, sy, { steps: 3 });
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  const isMovingDuringHold = await moving();
  await page.mouse.up();
  return isMovingDuringHold;
};

// ══ A. 长按拾取 ══
console.log('[A] 长按精炼炉 500ms → 移动态（真身隐藏 + 原占位释放）');
{
  await sectionReset();
  await clearAll();
  ok(await place('refining_unit', 35, 30), 'A0. 预置精炼炉 @(35,30)');
  const handleA = await firstHandle();
  const before = await occupiedCells();
  ok(before.length === 9, `A0b. 初始占用 9 格（实际 ${before.length}）`);
  const duringHold = await longPress(S.furnaceA.x, S.furnaceA.y);
  ok(duringHold, 'A1. 按住 500ms（未松开）已进入移动态');
  ok(await moving(), 'A2. 松开后仍在移动态（拾取持续，重放等待下一次左键）');
  ok((await movingHandle()) === handleA, 'A3. 移动态 handle = 被长按的设备');
  const occ = await occupiedCells();
  ok(occ.length === 0, `A4. 原占位已释放（占用 ${occ.length} 格，期望 0）`);
  const info = await previewInfo();
  ok(info !== null && info.valid === true && info.direction === 0, 'A5. 预览采样: 有效 + 朝向保持原朝向 0°');
  const grid = screenToGrid(S.furnaceA.x, S.furnaceA.y, 3, 3);
  ok(info !== null && info.grid.x === grid.gx && info.grid.y === grid.gy,
    `A6. 预览吸附回原格 (${grid.gx},${grid.gy})（实际 ${info ? `${info.grid.x},${info.grid.y}` : 'null'}）`);
  await shot('t214-A-longpress-preview');
}

// ══ B + C. R 旋转 → 左键重放 ══
console.log('[B/C] 移动态按 R 四档旋转；移到 (34,27) 按 2 次 R(→180°) 左键重放');
const handleA = await firstHandle();
{
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(100);
  const d90 = await previewInfo();
  ok(d90 !== null && d90.direction === 90, `B1. 按 1 次 R → 90°（实际 ${d90?.direction}°）`);
  await page.keyboard.press('KeyR');
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(100);
  const d270 = await previewInfo();
  ok(d270 !== null && d270.direction === 270, `B2. 再按 2 次 → 270°（实际 ${d270?.direction}°）`);
  await page.keyboard.press('KeyR'); // 270 → 0
  await page.waitForTimeout(100);
  const d0 = await previewInfo();
  ok(d0 !== null && d0.direction === 0, `B3. 第 4 次 → 回 0°（实际 ${d0?.direction}°）`);

  await page.keyboard.press('KeyR');
  await page.keyboard.press('KeyR'); // 0 → 90 → 180
  await page.waitForTimeout(100);
  await page.mouse.move(S.targetFree.x, S.targetFree.y, { steps: 4 });
  await page.waitForTimeout(100);
  await page.mouse.click(S.targetFree.x, S.targetFree.y);
  await page.waitForTimeout(200);
  ok(!(await moving()), 'C1. 重放成功 → 退出移动态');
  const p = await posOf(handleA);
  const grid = screenToGrid(S.targetFree.x, S.targetFree.y, 3, 3);
  const wx = grid.gx * 64, wy = grid.gy * 64;
  ok(p.x === wx && p.y === wy, `C2. Position 更新为 (${wx},${wy})（实际 ${p.x},${p.y}）`);
  ok((await dirOf(handleA)) === 180, `C3. direction = 180°（实际 ${await dirOf(handleA)}°）`);
  const occ = await occupiedCells();
  ok(occ.length === 9, `C4. 新占位 9 格（实际 ${occ.length}）`);
  ok(occ.every((c) => c.gx >= 34 && c.gx <= 36 && c.gy >= 27 && c.gy <= 29),
    'C5. 占位区域 = (34..36, 27..29)（Port 世界坐标随 Position 派生重算）');
  const comp = await compOf(handleA);
  ok(comp.paused === false, 'C6. 重放后恢复在线（paused 还原为进入前值 false）');
  await shot('t214-C-committed-180');
}

// ══ D. 放置失败（预览红 + 震动 + 保持移动态）══
console.log('[D] 预置设备 B；长按 A 拖到 B 上左键 → valid=false 保持移动态');
{
  ok(await place('refining_unit', 39, 30), 'D0. 预置阻挡设备 B @(39,30)');
  await longPress(S.targetFree.x, S.targetFree.y); // 拾取 A（现在在 34,27）
  await page.mouse.move(S.furnaceB.x, S.furnaceB.y, { steps: 4 });
  await page.waitForTimeout(150);
  const info = await previewInfo();
  ok(info !== null && info.valid === false, 'D1. 预览位置与设备 B 冲突 → valid=false（染红）');
  // 截图在点击前拍: 预览悬停 B 上呈红色无效态（不能停靠鼠标——预览跟随鼠标离开 B 会重新变蓝）
  await page.screenshot({ path: `${OUT_DIR}/t214-D-invalid-red-shake.png` });
  await page.mouse.click(S.furnaceB.x, S.furnaceB.y);
  await page.waitForTimeout(80); // 震动窗口内
  ok(await moving(), 'D2. 重放失败 → 保持在移动态');
  const p = await posOf(handleA);
  const grid = screenToGrid(S.targetFree.x, S.targetFree.y, 3, 3);
  ok(p.x === grid.gx * 64 && p.y === grid.gy * 64, 'D3. 设备 A 未被移动（仍在原格）');
}

// ══ E. 取消（右键放回原位 / ESC）══
console.log('[E] 右键取消 → 设备回 34,27/180°；再拾取+R+ESC 取消同样归位');
{
  await page.mouse.click(S.furnaceB.x, S.furnaceB.y, { button: 'right' });
  await page.waitForTimeout(150);
  ok(!(await moving()), 'E1. 右键 → 退出移动态');
  const occ1 = await occupiedCells();
  ok(occ1.length === 18, `E2. 取消后 A(9格)+B(9格)=18 格（实际 ${occ1.length}）`);
  ok((await dirOf(handleA)) === 180, `E2b. A 朝向保持 180°（实际 ${await dirOf(handleA)}°）`);
  // ESC 途径: 拾取 → R（预览转 90°）→ ESC → 应回到拾取前朝向
  await longPress(S.targetFree.x, S.targetFree.y);
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(100);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok(!(await moving()), 'E3. ESC → 退出移动态');
  ok((await dirOf(handleA)) === 180, `E4. 朝向还原 180°（实际 ${await dirOf(handleA)}°）`);
  const p = await posOf(handleA);
  const grid = screenToGrid(S.targetFree.x, S.targetFree.y, 3, 3);
  ok(p.x === grid.gx * 64 && p.y === grid.gy * 64, 'E5. 位置还原 (34,27)');
  ok((await occupiedCells()).length === 18, 'E6. 占用表仍 18 格（无泄漏）');
}

// ══ F. 短按 = 选中，与长按不冲突 ══
console.log('[F] 短按设备 → 仅选中弹窗，不进入移动态');
{
  await page.mouse.move(S.targetFree.x, S.targetFree.y, { steps: 2 });
  await page.mouse.down();
  await page.waitForTimeout(80); // <300ms
  await page.mouse.up();
  await page.waitForTimeout(300);
  ok(!(await moving()), 'F1. 短按未进入移动态');
  const selected = await game(() => window.__game.selection.getSelected());
  ok(selected === handleA, 'F2. 短按选中了设备');
  ok(await game(() => window.__game.deviceDialog.isOpen()), 'F3. 弹窗随选中弹出');
  await page.keyboard.press('Escape'); // 关弹窗
  await page.waitForTimeout(150);
}

// ══ H. 弹窗「移动」按钮 ══
console.log('[H] 弹窗点「移动」→ 关弹窗 + 进入移动态');
{
  await sectionReset();
  await game(() => window.__game.selection.clearSelection());
  await page.waitForTimeout(100);
  await game(() => window.__game.selectFirstBuilding());
  await page.waitForTimeout(200);
  ok(await game(() => window.__game.deviceDialog.isOpen()), 'H1. 选中 → 弹窗打开');
  const btns = page.locator('.efd-action-btn');
  ok((await btns.count()) === 2, `H2. 动作行有 移动+删除 两个按钮（实际 ${await btns.count()}）`);
  // 截图在点按钮前拍: 弹窗开着才能看到「移动」按钮（点完即关弹窗进移动态）
  await page.screenshot({ path: `${OUT_DIR}/t214-H-dialog-move-button.png` });
  await btns.first().click(); // 第一个 = 移动
  await page.waitForTimeout(200);
  ok(!(await game(() => window.__game.deviceDialog.isOpen())), 'H3. 弹窗已关闭');
  ok(await moving(), 'H4. 进入移动态');
  ok((await movingHandle()) === handleA, 'H5. 移动态 handle = 弹窗设备');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok(!(await moving()), 'H6. ESC 取消归位');
}

// ══ G. 运行时状态保留（半成品进度搬迁）══
console.log('[G] 注入源矿生产至半成品 → 搬迁 → 进度/缓冲区保留并续产');
{
  await sectionReset();
  await clearAll();
  ok(await place('refining_unit', 35, 30), 'G0. 预置精炼炉 @(35,30)');
  const h = await firstHandle();
  await game(([h]) => window.__game.injectInput('originium_ore', 5, h), [h]);
  // 等生产启动并走到 ~20%+（配方 2 秒）
  let before = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(100);
    before = await compOf(h);
    if (before.state === 'working' && before.progress >= 0.2) break;
  }
  ok(before !== null && before.state === 'working' && before.progress >= 0.2,
    `G1. 生产中 进度 ${(before?.progress * 100).toFixed(1)}%`);
  const cA = cellToScreen(35, 30, 3, 3);
  await longPress(cA.x, cA.y);
  const compDuring = await compOf(h);
  ok(compDuring.paused === true, 'G2. 移动期间设备离线（paused 临时置位）');
  const target = cellToScreen(39, 32, 3, 3); // (39..41, 32..34) 空地
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.waitForTimeout(150);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(150);
  ok(!(await moving()), 'G2b. 搬迁重放成功');
  const after = await compOf(h);
  ok(after.paused === false, 'G3. 重放后恢复在线');
  ok(after.input0 === before.input0, `G4. 输入缓冲区保留（${before.input0} → ${after.input0}）`);
  // 进度保留语义: 拾取瞬间不清零不重置——elapsed 从进入移动态前的值**续走**。
  // 长按阈值 300ms 内设备尚未离线（此时还只是"普通按压"），生产合法推进
  // ≤300ms + 2 Tick 量化 + evaluate 往返 ≈ 450ms；进入移动态后冻结。
  ok(after.elapsed >= before.elapsed && after.elapsed - before.elapsed <= 550,
    `G5. 生产进度保留（elapsed ${before.elapsed} → ${after.elapsed}ms，仅拾取前 ≤300ms 窗口推进，未重置）`);
  // 继续生产: 等 3 秒后 elapsed 应明显前进（或已结算产出）
  await page.waitForTimeout(3000);
  const later = await compOf(h);
  ok(later.elapsed > after.elapsed || later.output0 > 0,
    `G6. 重放后继续生产（elapsed ${after.elapsed} → ${later.elapsed}）`);
}

// ══ I. 非正方形占地（取货口 3×1 ↔ 1×3）══
console.log('[I] 取货口 3×1 拾取 + R 旋转 90° → 按 1×3 有效占地落盘');
{
  await sectionReset();
  await clearAll();
  ok(await place('depot_unloader', 35, 34, 0), 'I0. 预置取货口 3×1 @(35,34)');
  const hDepot = await lastHandle();
  const sDepot = cellToScreen(35, 34, 3, 1);
  await longPress(sDepot.x, sDepot.y);
  ok(await moving(), 'I1. 拾取取货口');
  await page.keyboard.press('KeyR'); // 0 → 90（3×1 → 1×3）
  await page.waitForTimeout(100);
  const info = await previewInfo();
  ok(info !== null && info.direction === 90, `I2. 预览朝向 90°（实际 ${info?.direction}°）`);
  await page.mouse.move(S.depotV.x, S.depotV.y, { steps: 4 });
  await page.waitForTimeout(100);
  await page.mouse.click(S.depotV.x, S.depotV.y);
  await page.waitForTimeout(150);
  ok(!(await moving()), 'I3. 重放成功');
  ok((await dirOf(hDepot)) === 90, `I4. direction=90°（实际 ${await dirOf(hDepot)}°）`);
  const p = await posOf(hDepot);
  const grid = screenToGrid(S.depotV.x, S.depotV.y, 1, 3);
  ok(p.x === grid.gx * 64 && p.y === grid.gy * 64,
    `I5. 落盘左上角 (${grid.gx * 64},${grid.gy * 64})（实际 ${p.x},${p.y}）——1×3 竖放占地`);
  const occ = await occupiedCells();
  ok(occ.length === 3, `I6. 占用 3 格（实际 ${occ.length}）`);
  ok(occ.every((c) => c.gx === grid.gx && c.gy >= grid.gy && c.gy <= grid.gy + 2),
    'I7. 占用区域为竖 1×3');
  await shot('t214-I-depot-rotated-1x3');
}

// ══ J. 占位无泄漏（多次移动/取消循环）══
console.log('[J] 炉 拾取↔取消 ×5 + 口 拾取↔旋转↔重放 ×5 → 占用表 Cell 数恒定');
{
  await sectionReset();
  await clearAll();
  await place('refining_unit', 35, 30);
  await place('depot_unloader', 39, 34, 0);
  const hF = await firstHandle();
  const hD = await lastHandle();
  // 9 (3×3) + 3 (3×1) = 12
  const baseCount = (await occupiedCells()).length;
  ok(baseCount === 12, `J0. 基准占用 12 格（实际 ${baseCount}）`);
  // 取货口横放中心 (39,34) 3×1 → 屏幕 (1184,520)；R 后鼠标=中心落 1×3 @ (40,33)（同一屏幕点）
  const sD = cellToScreen(39, 34, 3, 1);
  const vGrid = screenToGrid(sD.x, sD.y, 1, 3); // R 后同一屏幕点的落盘格
  let stable = true;
  for (let i = 0; i < 5; i++) {
    // 炉: 拾取 → ESC（取消归位）
    await longPress(S.furnaceA.x, S.furnaceA.y);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    // 口: 拾取 → R → 重放到竖 1×3
    await longPress(sD.x, sD.y);
    await page.keyboard.press('KeyR');
    await page.mouse.click(sD.x, sD.y);
    await page.waitForTimeout(80);
    // 口: 拾取（现在在竖位）→ R×3（回 0°）→ 重放回横位
    const sDv = cellToScreen(vGrid.gx, vGrid.gy, 1, 3);
    await longPress(sDv.x, sDv.y);
    for (let k = 0; k < 3; k++) await page.keyboard.press('KeyR');
    await page.mouse.click(sD.x, sD.y);
    await page.waitForTimeout(80);
    const n = (await occupiedCells()).length;
    if (n !== 12) { stable = false; console.error(`    第 ${i + 1} 轮后占用 ${n} 格（期望 12）`); }
  }
  ok(stable, 'J1. 5 轮 移动/取消/旋转/重放 后占用表恒 12 格（无泄漏）');
  const pf = await posOf(hF);
  ok(pf.x === 35 * 64 && pf.y === 30 * 64, 'J2. 精炼炉仍在 (35,30)');
  const pd = await posOf(hD);
  ok(pd.x === 39 * 64 && pd.y === 34 * 64 && (await dirOf(hD)) === 0,
    `J3. 取货口仍在 (39,34) 0°（实际 (${pd.x / 64},${pd.y / 64}) ${await dirOf(hD)}°）`);
}

// ══ K. 端口连接自动重算（接带设备搬迁 → 连接断开，传送带不跟随）══
console.log('[K] 精炼炉接供给带后搬迁 → 旧带留在原位、新位置端口未连接');
{
  await sectionReset();
  await clearAll();
  ok(await place('refining_unit', 35, 30), 'K0. 预置精炼炉 @(35,30)');
  // 3 段上行带，尾格 (36,33)（供给格）指向底中输入端口 (36,32)（端口格=footprint 底行
  // 自身，同 demoT26: (5,5) 炉端口 (6,7)/供给格 (6,8)）（A9 §6.7 同一判定源）
  ok(await game(() => window.__game.spawnBelt([[36, 35], [36, 34], [36, 33]], 270)) === 3, 'K0b. 预置供给带 ×3');
  await page.waitForTimeout(200);
  const stBefore = await game(() => window.__game.portStatus());
  ok(stBefore.includes('●黄(已连接)'), 'K1. 输入口已连接（●黄）');
  const cA = cellToScreen(35, 30, 3, 3);
  await longPress(cA.x, cA.y);
  ok(await moving(), 'K2. 拾取精炼炉（传送带不受影响）');
  const beltCellsDuring = (await occupiedCells()).filter((c) => c.defId === 'transport_belt').length;
  ok(beltCellsDuring === 3, `K3. 移动期间传送带 3 格占用保持（实际 ${beltCellsDuring}）`);
  const target = cellToScreen(39, 27, 3, 3); // (39..41, 27..29) 远离旧位置
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.waitForTimeout(100);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(200);
  ok(!(await moving()), 'K4. 搬迁重放成功');
  const stAfter = await game(() => window.__game.portStatus());
  // 注: 表头图例含"黄=已连接"字样，故用带状态符号的完整串匹配
  ok(!stAfter.includes('●黄(已连接)') && stAfter.includes('未连接'),
    'K5. 新位置端口未连接（Port 世界坐标随搬迁重算，带不自动跟随——有意限制）');
  const beltCells = (await occupiedCells()).filter((c) => c.defId === 'transport_belt').length;
  ok(beltCells === 3, `K6. 传送带 3 格原位不动（实际 ${beltCells}）`);
  const devCells = (await occupiedCells()).filter((c) => c.defId !== 'transport_belt').length;
  ok(devCells === 9, `K7. 设备新占位 9 格（实际 ${devCells}）`);
  await shot('t214-K-moved-away-belt-stays');
}

// ══ 汇总 ══
console.log(`\n════ T2.14 验收: ${passed} 通过 / ${failed} 失败 ════`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
