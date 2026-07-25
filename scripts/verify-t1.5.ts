// T1.5 视图操作验证脚本（Camera 旋转数学 + 屏幕相对方向映射）
// 用法: node --experimental-strip-types scripts/verify-t1.5.ts
//
// 验证 A6 coordinate-spec.md §4 / §4.0 (viewRotation) 与 T1.5 的关键行为:
//   1. worldToScreen / screenToWorld 在 4 个旋转态下逐点互逆
//   2. 旋转以屏幕中心为枢轴：相机中心恒映射到视口中央（任意旋转）
//   3. rotateClockwise 4 态循环 0→90→180→270→0
//   4. screenDirToWorld: WASD 屏幕相对映射（rot=90 时屏幕上→世界 +X 等）
//   5. zoomAt 在旋转视图下仍以鼠标为锚点（锚点屏幕坐标不变）
//   6. 边界 clamp 在旋转视图下仍生效（相机中心不越世界边界）
//   7. rotateClockwise 不改变相机中心（只改呈现方式）
//
// 注: updateTransform 写入 PixiJS Container 的正确性已在开发期用独立脚本
//     验证（pivot=camCenter, position=VP/2, scale=zoom, rotation=−viewRotation*π/180），
//     与 worldToScreen 逐像素一致；此处不依赖 PixiJS 运行时。

import { Camera } from '../src/game/render/Camera.ts';
import {
  WORLD_WIDTH_PX,
  WORLD_HEIGHT_PX,
  CAMERA_ZOOM_MIN,
  CAMERA_ZOOM_MAX,
} from '../src/game/render/constants.ts';

let passed = 0;
let failed = 0;

function approxEqual(a: number, b: number, eps = 0.001): boolean {
  return Math.abs(a - b) < eps;
}

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

console.log('\n=== T1.5 视图操作验证 (Camera 旋转数学 + 平滑过渡) ===\n');

const VIEWPORT = { width: 1280, height: 720 };
const ROTATIONS = [0, 90, 180, 270] as const;

/**
 * 把相机旋转到目标离散态，并驱动平滑动画到结束，使 _displayRotation == 目标弧度。
 * 测试坐标转换必须在动画结束后进行（动画期间 displayRotation 是中间值）。
 * 通过多次 rotateClockwise + update 模拟主循环，比直接设 viewRotation 更真实。
 *
 * 注意: 每次 rotateClockwise 后必须立即把动画 update 到结束，再触发下一次——
 * 否则连续 rotate 时 _rotAnimFrom 取的是未推进的旧 _displayRotation，多次的 to
 * 会相互覆盖。这模拟"玩家每次按完 Ctrl+R 等动画结束再按下一次"的真实场景。
 */
function setRotationAndFinishAnim(cam: Camera, target: 0 | 90 | 180 | 270): void {
  // 算出需要顺时针旋转的次数 (当前 viewRotation → target)
  const steps = (((target - cam.viewRotation) % 360) + 360) % 360 / 90;
  for (let i = 0; i < steps; i++) {
    cam.rotateClockwise();
    // 每次旋转都驱动到动画结束，确保下次 rotateClockwise 的起点正确
    for (let f = 0; f < 100; f++) cam.update(16);
  }
}

// ── 1. worldToScreen / screenToWorld 互逆（4 旋转态）──
console.log('[1] worldToScreen / screenToWorld 互逆（4 旋转态）');
{
  const cam = new Camera(VIEWPORT);
  cam.x = 1500;
  cam.y = 2000;
  cam.zoom = 2.0;
  const worldPts = [
    { x: 1000, y: 1800 },
    { x: cam.x, y: cam.y },
    { x: 0, y: 0 },
    { x: 3500, y: 4200 },
  ];
  for (const rot of ROTATIONS) {
    setRotationAndFinishAnim(cam, rot);
    for (const wp of worldPts) {
      const sp = cam.worldToScreen(wp.x, wp.y);
      const back = cam.screenToWorld(sp.x, sp.y);
      assert(approxEqual(back.x, wp.x) && approxEqual(back.y, wp.y),
        `rot=${rot}° 互逆: world(${wp.x},${wp.y})→screen(${sp.x.toFixed(1)},${sp.y.toFixed(1)})→world 还原`);
    }
  }
}

// ── 2. 旋转以屏幕中心为枢轴：相机中心 → 视口中央 ──
console.log('\n[2] 旋转以屏幕中心为枢轴（相机中心恒在视口中央）');
{
  const cam = new Camera(VIEWPORT);
  for (const rot of ROTATIONS) {
    setRotationAndFinishAnim(cam, rot);
    const center = cam.worldToScreen(cam.x, cam.y);
    assert(approxEqual(center.x, VIEWPORT.width / 2) && approxEqual(center.y, VIEWPORT.height / 2),
      `rot=${rot}° 相机中心(${cam.x},${cam.y}) → 视口中央(${VIEWPORT.width / 2},${VIEWPORT.height / 2})`);
  }
}

// ── 3. rotateClockwise 4 态循环 ──
console.log('\n[3] rotateClockwise 4 态循环 0→90→180→270→0');
{
  const cam = new Camera(VIEWPORT);
  assert(cam.viewRotation === 0, `初始 viewRotation = 0`);
  cam.rotateClockwise();
  assert(cam.viewRotation === 90, `第 1 次 → 90`);
  cam.rotateClockwise();
  assert(cam.viewRotation === 180, `第 2 次 → 180`);
  cam.rotateClockwise();
  assert(cam.viewRotation === 270, `第 3 次 → 270`);
  cam.rotateClockwise();
  assert(cam.viewRotation === 0, `第 4 次 → 0（循环回起点）`);
}

// ── 4. screenDirToWorld: WASD 屏幕相对映射 ──
console.log('\n[4] screenDirToWorld 屏幕相对方向映射');
{
  const cam = new Camera(VIEWPORT);
  // 屏幕"上"方向 (0, -1) 在各旋转态下映射到的世界方向
  setRotationAndFinishAnim(cam, 0);
  let d = cam.screenDirToWorld(0, -1);
  assert(approxEqual(d.x, 0) && approxEqual(d.y, -1),
    `rot=0° 屏幕上(0,−1) → 世界上(0,−1)（不转）`);

  setRotationAndFinishAnim(cam, 90);
  d = cam.screenDirToWorld(0, -1);
  // 视图顺时针转 90°，原世界的"右"现在显示在屏幕的"上"，按 W 让相机 +X
  assert(approxEqual(d.x, 1) && approxEqual(d.y, 0),
    `rot=90° 屏幕上(0,−1) → 世界右(+1,0)`);

  setRotationAndFinishAnim(cam, 180);
  d = cam.screenDirToWorld(0, -1);
  assert(approxEqual(d.x, 0) && approxEqual(d.y, 1),
    `rot=180° 屏幕上(0,−1) → 世界下(0,+1)`);

  setRotationAndFinishAnim(cam, 270);
  d = cam.screenDirToWorld(0, -1);
  assert(approxEqual(d.x, -1) && approxEqual(d.y, 0),
    `rot=270° 屏幕上(0,−1) → 世界左(−1,0)`);

  // 屏幕右方向 (1, 0) 也验证一下（对角方向用得到）
  setRotationAndFinishAnim(cam, 90);
  d = cam.screenDirToWorld(1, 0);
  assert(approxEqual(d.x, 0) && approxEqual(d.y, 1),
    `rot=90° 屏幕右(+1,0) → 世界下(0,+1)`);
}

// ── 5. zoomAt 在旋转视图下仍以鼠标为锚点 ──
console.log('\n[5] zoomAt 旋转视图下以鼠标为锚点（锚点屏幕坐标不变）');
{
  const cam = new Camera(VIEWPORT);
  cam.setPosition(2048, 2048);
  cam.setZoom(1.0);

  for (const rot of ROTATIONS) {
    setRotationAndFinishAnim(cam, rot);
    const anchor = { x: 600, y: 400 };
    const beforeWorld = cam.screenToWorld(anchor.x, anchor.y);

    cam.zoomAt(anchor, 2.5);
    const afterWorld = cam.screenToWorld(anchor.x, anchor.y);
    // 锚点的世界坐标应不变（同一世界点缩放前后钉在屏幕同一位置）
    assert(approxEqual(beforeWorld.x, afterWorld.x) && approxEqual(beforeWorld.y, afterWorld.y),
      `rot=${rot}° zoomAt 后锚点世界坐标不变 (${afterWorld.x.toFixed(1)},${afterWorld.y.toFixed(1)})`);
    // 锚点屏幕坐标也应不变（"以鼠标为中心"的定义）
    const anchorScreen = cam.worldToScreen(beforeWorld.x, beforeWorld.y);
    assert(approxEqual(anchorScreen.x, anchor.x) && approxEqual(anchorScreen.y, anchor.y),
      `rot=${rot}° 锚点屏幕位置不变 (${anchorScreen.x.toFixed(1)},${anchorScreen.y.toFixed(1)})`);
  }
}

// ── 6. 边界 clamp 在旋转视图下仍生效 ──
console.log('\n[6] 边界 clamp 在旋转视图下仍生效');
{
  const cam = new Camera(VIEWPORT);
  for (const rot of ROTATIONS) {
    setRotationAndFinishAnim(cam, rot);
    cam.setZoom(1.0);
    cam.setPosition(-99999, -99999);
    const halfW = VIEWPORT.width / 2 / cam.zoom;
    const halfH = VIEWPORT.height / 2 / cam.zoom;
    assert(approxEqual(cam.x, halfW) && approxEqual(cam.y, halfH),
      `rot=${rot}° 左上越界 clamp 到 (${halfW},${halfH})，实际 (${cam.x.toFixed(0)},${cam.y.toFixed(0)})`);

    cam.setPosition(99999, 99999);
    assert(approxEqual(cam.x, WORLD_WIDTH_PX - halfW) && approxEqual(cam.y, WORLD_HEIGHT_PX - halfH),
      `rot=${rot}° 右下越界 clamp 到 (${WORLD_WIDTH_PX - halfW},${WORLD_HEIGHT_PX - halfH})`);
  }
}

// ── 7. rotateClockwise 不改变相机中心 ──
console.log('\n[7] rotateClockwise 不改变相机中心（只改呈现方式）');
{
  const cam = new Camera(VIEWPORT);
  cam.setPosition(1234, 2345);
  const beforeX = cam.x;
  const beforeY = cam.y;
  cam.rotateClockwise();
  cam.rotateClockwise();
  assert(approxEqual(cam.x, beforeX) && approxEqual(cam.y, beforeY),
    `连续旋转 2 次后相机中心不变 (${cam.x},${cam.y})`);
}

// ── 8. zoom 边界回归（旋转不应影响 zoom clamp）──
console.log('\n[8] zoom 边界回归 [0.25, 4.0]（旋转不影响）');
{
  const cam = new Camera(VIEWPORT);
  setRotationAndFinishAnim(cam, 90);
  cam.setZoom(100);
  assert(approxEqual(cam.zoom, CAMERA_ZOOM_MAX), `rot=90° setZoom(100) clamp 到 ${CAMERA_ZOOM_MAX}`);
  cam.setZoom(0.01);
  assert(approxEqual(cam.zoom, CAMERA_ZOOM_MIN), `rot=90° setZoom(0.01) clamp 到 ${CAMERA_ZOOM_MIN}`);
}

// ── 9. 平滑旋转: 动画结束后 displayRotation 精确等于目标 ──
console.log('\n[9] 平滑旋转动画结束后 displayRotation 吸附到目标');
{
  const cam = new Camera(VIEWPORT);
  cam.x = 1500;
  cam.y = 2000;
  cam.zoom = 1.5;

  // rotateClockwise 启动动画, 此时 viewRotation 已是目标(90), 但 displayRotation 还在起点
  cam.rotateClockwise();
  assert(cam.viewRotation === 90, `rotateClockwise 后 viewRotation 立即为 90`);
  // 动画期间 isRotating 为 true
  assert(cam.isRotating === true, `动画期间 isRotating = true`);
  // 驱动到结束
  for (let i = 0; i < 100; i++) cam.update(16);
  assert(cam.isRotating === false, `动画结束后 isRotating = false`);
  // 结束后 worldToScreen 应与"直接设 viewRotation=90 + displayRotation=π/2"一致:
  // 即相机中心映射到视口中央(互逆性的体现)
  const center = cam.worldToScreen(cam.x, cam.y);
  assert(approxEqual(center.x, VIEWPORT.width / 2) && approxEqual(center.y, VIEWPORT.height / 2),
    `动画结束后相机中心仍在视口中央 (${center.x.toFixed(1)},${center.y.toFixed(1)})`);
  // 互逆: 动画结束态下 worldToScreen/screenToWorld 仍严格互逆
  const wp = { x: 1000, y: 1800 };
  const sp = cam.worldToScreen(wp.x, wp.y);
  const back = cam.screenToWorld(sp.x, sp.y);
  assert(approxEqual(back.x, wp.x) && approxEqual(back.y, wp.y),
    `动画结束后互逆: world(${wp.x},${wp.y})→screen→world 还原`);
}

// ── 10. 平滑旋转: 动画期间(连续中间角度)互逆仍成立 ──
console.log('\n[10] 平滑旋转动画期间(连续中间角度) worldToScreen/screenToWorld 互逆');
{
  const cam = new Camera(VIEWPORT);
  cam.x = 1500;
  cam.y = 2000;
  cam.zoom = 2.0;
  cam.rotateClockwise(); // 启动 0→90° 动画
  const worldPts = [
    { x: 1000, y: 1800 },
    { x: cam.x, y: cam.y },
    { x: 0, y: 0 },
  ];
  // 在动画的多个中间时刻验证互逆(此时 displayRotation 是 0~π/2 之间的连续值)
  let allInverse = true;
  for (let frame = 0; frame < 15; frame++) {
    cam.update(16); // 推进动画
    for (const wp of worldPts) {
      const sp = cam.worldToScreen(wp.x, wp.y);
      const back = cam.screenToWorld(sp.x, sp.y);
      if (!approxEqual(back.x, wp.x) || !approxEqual(back.y, wp.y)) {
        allInverse = false;
      }
    }
  }
  assert(allInverse, `动画全程 15 帧各时刻 worldToScreen/screenToWorld 严格互逆`);
}

// ── 11. 平滑旋转: 连按 Ctrl+R 在动画未结束时接续, 无角度突变 ──
console.log('\n[11] 连按 Ctrl+R(动画未结束时再次触发)无突变');
{
  const cam = new Camera(VIEWPORT);
  cam.rotateClockwise(); // 0→90, from=0 to=π/2
  cam.update(32); // 推进 2 帧, displayRotation 在 0~π/2 之间
  const midRot = cam.worldToScreen(2000, 2000); // 中间态参考点
  // 此时再按一次: 新 from = 当前 displayRotation, to = from + π/2
  cam.rotateClockwise();
  assert(cam.viewRotation === 180, `连按第 2 次 viewRotation = 180`);
  // 接续后第一帧画面不应跳变: 旋转角度连续(from 接上当前 displayRotation)
  // 验证方式: 接续瞬间(未 update) worldToScreen 结果应与接续前一致
  const afterTrigger = cam.worldToScreen(2000, 2000);
  assert(approxEqual(afterTrigger.x, midRot.x) && approxEqual(afterTrigger.y, midRot.y),
    `连按瞬间画面不跳变(角度接续连续)`);
  // 最终驱动到结束应到 180° 态
  for (let i = 0; i < 100; i++) cam.update(16);
  const center = cam.worldToScreen(cam.x, cam.y);
  assert(approxEqual(center.x, VIEWPORT.width / 2) && approxEqual(center.y, VIEWPORT.height / 2),
    `连按后最终到 180° 态, 相机中心在视口中央`);
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
if (failed > 0) {
  process.exit(1);
}
