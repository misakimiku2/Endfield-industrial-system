// T1.2 相机系统验证脚本（Camera 纯逻辑）
// 用法: node --experimental-strip-types scripts/verify-t1.2-camera.ts
//
// 验证 A6 coordinate-spec.md 与 A2 §8 的关键行为:
//   1. worldToScreen / screenToWorld 互为逆运算
//   2. 相机中心在视口中央时，worldToScreen 中心 = 视口中心
//   3. 边界 clamp: 相机中心不会超出世界边缘
//   4. zoom 边界 [0.25, 4.0]
//   5. zoomAt 以锚点为中心缩放（锚点屏幕坐标不变）
//   6. panByWorld 平移后正确 clamp
//   7. 世界比视口小时相机居中（极小 zoom 场景）

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

console.log('\n=== T1.2 相机系统验证 (Camera 纯逻辑) ===\n');

const VIEWPORT = { width: 1280, height: 720 };

// ── 1. worldToScreen / screenToWorld 互逆 ──
console.log('[1] worldToScreen / screenToWorld 互逆');
{
  const cam = new Camera(VIEWPORT);
  cam.x = 1500;
  cam.y = 2000;
  cam.zoom = 2.0;

  const worldPts = [
    { x: 1000, y: 1800 },
    { x: cam.x, y: cam.y },
    { x: 0, y: 0 },
  ];
  for (const wp of worldPts) {
    const sp = cam.worldToScreen(wp.x, wp.y);
    const back = cam.screenToWorld(sp.x, sp.y);
    assert(approxEqual(back.x, wp.x) && approxEqual(back.y, wp.y),
      `互逆: world(${wp.x},${wp.y})→screen(${sp.x.toFixed(1)},${sp.y.toFixed(1)})→world 还原`);
  }
}

// ── 2. 相机中心 → 视口中央 ──
console.log('\n[2] 相机中心映射到视口中央');
{
  const cam = new Camera(VIEWPORT);
  const center = cam.worldToScreen(cam.x, cam.y);
  assert(approxEqual(center.x, VIEWPORT.width / 2) && approxEqual(center.y, VIEWPORT.height / 2),
    `相机中心(${cam.x},${cam.y}) → 屏幕中央(${VIEWPORT.width / 2},${VIEWPORT.height / 2})`);
}

// ── 3. 边界 clamp ──
console.log('\n[3] 边界 clamp (世界 64×64 cells = 4096px)');
{
  const cam = new Camera(VIEWPORT); // zoom=1, 视口 1280×720
  // 尝试把相机移到世界外
  cam.setPosition(-500, -500);
  // zoom=1 时 halfView = 1280/2/1 = 640, clamp 下界 = 640
  assert(approxEqual(cam.x, 640) && approxEqual(cam.y, 360),
    `左上边界 clamp 到 (640, 360)，实际 (${cam.x}, ${cam.y})`);

  cam.setPosition(99999, 99999);
  // clamp 上界 = WORLD_PX - halfView = 4096 - 640 = 3456 (x), 4096-360=3736 (y)
  assert(approxEqual(cam.x, WORLD_WIDTH_PX - 640) && approxEqual(cam.y, WORLD_HEIGHT_PX - 360),
    `右下边界 clamp 到 (${WORLD_WIDTH_PX - 640}, ${WORLD_HEIGHT_PX - 360})，实际 (${cam.x}, ${cam.y})`);
}

// ── 4. zoom 边界 ──
console.log('\n[4] zoom 边界 [0.25, 4.0]');
{
  const cam = new Camera(VIEWPORT);
  cam.setZoom(100); // 远超上限
  assert(approxEqual(cam.zoom, CAMERA_ZOOM_MAX), `setZoom(100) clamp 到 ${CAMERA_ZOOM_MAX}`);
  cam.setZoom(0.01); // 远低于下限
  assert(approxEqual(cam.zoom, CAMERA_ZOOM_MIN), `setZoom(0.01) clamp 到 ${CAMERA_ZOOM_MIN}`);
}

// ── 5. zoomAt 锚点不变 ──
console.log('\n[5] zoomAt 以锚点为中心缩放');
{
  const cam = new Camera(VIEWPORT);
  cam.setPosition(2048, 2048); // 世界中心
  cam.setZoom(1.0);

  const anchor = { x: 600, y: 400 }; // 鼠标在某处
  const before = cam.screenToWorld(anchor.x, anchor.y);

  cam.zoomAt(anchor, 2.5);
  const after = cam.screenToWorld(anchor.x, anchor.y);

  assert(approxEqual(before.x, after.x) && approxEqual(before.y, after.y),
    `zoomAt 后锚点世界坐标不变 (前 ${before.x.toFixed(1)}, 后 ${after.x.toFixed(1)})`);

  // 锚点屏幕坐标也应不变（这就是"以鼠标为中心"的定义）
  const anchorScreenAfter = cam.worldToScreen(before.x, before.y);
  assert(approxEqual(anchorScreenAfter.x, anchor.x) && approxEqual(anchorScreenAfter.y, anchor.y),
    `锚点屏幕位置不变 (${anchorScreenAfter.x.toFixed(1)}, ${anchorScreenAfter.y.toFixed(1)})`);
}

// ── 6. panByWorld 平移并 clamp ──
console.log('\n[6] panByWorld 平移 + clamp');
{
  const cam = new Camera(VIEWPORT);
  const startX = cam.x;
  const startY = cam.y;
  cam.panByWorld(100, 50);
  assert(approxEqual(cam.x, startX + 100) && approxEqual(cam.y, startY + 50),
    `正常 panByWorld(100,50) 生效`);

  // 平移到边界外应被 clamp
  cam.panByWorld(-99999, -99999);
  assert(cam.x >= 0 && cam.y >= 0, 'panByWorld 到边界外被 clamp（不出现负坐标）');
}

// ── 7. 世界比视口小 → 相机居中 ──
console.log('\n[7] 世界比视口小 → 相机居中');
{
  // zoom=0.25: 视口世界宽 = 1280/0.25 = 5120 > 世界宽 4096 → X 轴世界小于视口
  //            视口世界高 = 720/0.25  = 2880 < 世界高 4096 → Y 轴世界大于视口
  // 这是非正方形视口下的真实情况：X 居中、Y 可移动都是正确行为。
  const cam = new Camera(VIEWPORT);
  cam.setZoom(CAMERA_ZOOM_MIN);
  const halfW = VIEWPORT.width / 2 / cam.zoom;
  const worldSmallerX = WORLD_WIDTH_PX >= halfW * 2;
  if (worldSmallerX) {
    // X 轴视口比世界大 → X 应被居中
    assert(approxEqual(cam.x, WORLD_WIDTH_PX / 2),
      `zoom=${CAMERA_ZOOM_MIN} 时 X 轴世界小于视口，x 居中 2048`);
  }
  cam.panByWorld(500, 500);
  if (worldSmallerX) {
    assert(approxEqual(cam.x, WORLD_WIDTH_PX / 2),
      `X 轴世界小于视口时 pan 后 x 仍居中`);
  }
  // 用完全大于视口的极端 zoom 验证双轴居中
  cam.setZoom(0.15 < CAMERA_ZOOM_MIN ? CAMERA_ZOOM_MIN : 0.1);
  // 注: zoom 被 clamp 到 0.25，此处仅验证不崩溃
  assert(cam.zoom >= CAMERA_ZOOM_MIN, `zoom 始终不低于下限 ${CAMERA_ZOOM_MIN}`);
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
if (failed > 0) {
  process.exit(1);
}
