// 传送带指针 v7 格级像素互斥验证: 每格画面上只允许指针或物品其一
// 依据: 2026-08-27 用户直线带实拍复现"指针与物品同格"并重申不变量。
//       根因: 物品贴图前半身越界 ~16px + 指针尖端越界 ~8px，按段判定下跨格瞬态
//       与邻格空段指针像素共存。修复: 邻段任一物品渲染位置压到本格矩形 → 本格
//       指针让位（beltItemGeom.itemWorldPosOnSegment + circleIntersectsRect）。
//
// 用法: node --experimental-strip-types scripts/verify-belt-pointer-exclusivity.ts
//
// 断言:
//   A. circleIntersectsRect 几何基元（内/外/相切）
//   B. itemWorldPosOnSegment 与 BeltItemRenderer.itemTransform 逐字一致（防漂移）
//      —— 直段四方向入口边起算约定 + 转角弧端点连续性 + progress>1 出口延伸
//   C. 占据判定场景:
//      c1 上游物品接近边界(0.95) → 下游空格被占据（指针隐藏）
//      c2 排队物品停格中心(0.5) → 相邻格不误伤
//      c3 转角物品快出弯(0.98) → 下游直格被占据
//      c4 端口预约延伸(progress>1) → 目标段(门口格)被占据
//      c5 疏远即恢复: 物品离开边界带 → 相邻格指针恢复显示

import {
  itemWorldPosOnSegment,
  circleIntersectsRect,
  ITEM_PROBE_RADIUS,
} from '../src/game/render/beltItemGeom.ts';
import { CELL_SIZE } from '../src/game/render/constants.ts';
import type { Direction } from '../src/game/components/BuildingComp.ts';
import type { BeltSegmentComp } from '../src/game/components/BeltSegmentComp.ts';

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function seg(partial: Partial<BeltSegmentComp>): BeltSegmentComp {
  return {
    chainId: 't', direction: 0, isCorner: false, isTail: false,
    items: [], blocked: false, ...partial,
  } as BeltSegmentComp;
}
const pos = (gx: number, gy: number) => ({ x: gx * CELL_SIZE, y: gy * CELL_SIZE });

console.log('--- A. circleIntersectsRect 基元 ---');
assert(circleIntersectsRect(50, 50, 20, 0, 0, 64, 64), '圆心在矩形内 → 相交');
assert(circleIntersectsRect(80, 32, 20, 0, 0, 64, 64), '圆心在右边外 16px < r=20 → 相交');
assert(!circleIntersectsRect(90, 32, 20, 0, 0, 64, 64), '圆心在右边外 26px > r=20 → 不相交');
assert(circleIntersectsRect(84, 32, 20, 0, 0, 64, 64), '圆与右边界恰好相切(距离=r) → 相交');

console.log('--- B. 与 BeltItemRenderer.itemTransform 一致性 ---');
for (const dir of [0, 90, 180, 270] as Direction[]) {
  const s = seg({ direction: dir });
  const p = pos(3, 4);
  for (const prog of [0, 0.35, 1]) {
    // 直段约定: progress 0=入口边中点, 1=出口边中点（A9 §5.3.2）
    const expected = (() => {
      const off = prog * CELL_SIZE;
      switch (dir) {
        case 0:   return { x: p.x + off, y: p.y + CELL_SIZE / 2 };
        case 90:  return { x: p.x + CELL_SIZE / 2, y: p.y + off };
        case 180: return { x: p.x + CELL_SIZE - off, y: p.y + CELL_SIZE / 2 };
        case 270: return { x: p.x + CELL_SIZE / 2, y: p.y + CELL_SIZE - off };
      }
    })();
    const got = itemWorldPosOnSegment(s, p, prog);
    assert(got.x === expected.x && got.y === expected.y,
      `dir=${dir} progress=${prog} 坐标逐字一致 (${got.x},${got.y})`);
  }
}
{
  // 转角 ↑→（entryDir=270→out=0）: 弧终点 = 出口边中点；>1 沿出口方向直线延伸
  const corner = seg({ isCorner: true, entryDir: 270, direction: 0 });
  const p = pos(5, 6);
  const end = itemWorldPosOnSegment(corner, p, 1);
  const mid1 = itemWorldPosOnSegment(corner, p, 0);
  // 入口点 = 进入边（下边）中点；出口点 = 出口边（右边）中点
  assert(mid1.y === p.y + CELL_SIZE && mid1.x === p.x + CELL_SIZE / 2,
    `转角入口=进入边中点 (${mid1.x - p.x},${mid1.y - p.y})`);
  assert(end.x === p.x + CELL_SIZE && end.y === p.y + CELL_SIZE / 2,
    `转角出口=出口边中点 (${end.x - p.x},${end.y - p.y})`);
  const ext = itemWorldPosOnSegment(corner, p, 1.25);
  assert(ext.x === end.x + CELL_SIZE * 0.25 && ext.y === end.y,
    'progress>1 沿出口方向直线延伸 0.25 格');
}

console.log('--- C. 占据判定场景（r=ITEM_PROBE_RADIUS 对格矩形）---');
const r = ITEM_PROBE_RADIUS;
const hit = (segDef: ReturnType<typeof seg>, sp: { x: number; y: number }, prog: number,
             cellGx: number, cellGy: number): boolean => {
  const pt = itemWorldPosOnSegment(segDef, sp, prog);
  return circleIntersectsRect(pt.x, pt.y, r, cellGx * CELL_SIZE, cellGy * CELL_SIZE, CELL_SIZE, CELL_SIZE);
};
// 场景坐标: 三格竖直链 dir270，cells 行34/33/32（col31）。行34 是链首(靠近供料)
{
  const up = seg({ direction: 270 });
  const p34 = pos(31, 34);
  assert(hit(up, p34, 0.95, 31, 33), 'c1 物品距出口边 0.05 格 → 上一格被占据');
  assert(hit(up, p34, 0.88, 31, 33), 'c1b 物品前缘伸入上一格约半张贴图 → 上一格被占据');
  assert(!hit(up, p34, 0.5, 31, 33), 'c2 排队停格中心 → 上一格不误伤');
  assert(!hit(up, p34, 0.5, 30, 34), 'c2b 侧向邻格不误伤（横向互斥同样成立的前提是无接触）');
  assert(hit(up, p34, 0.02, 31, 34), 'c2c 刚从本格出发(0.02) → 本格自身被占据(按段判定等价)');
}
{
  // c3 转角快出弯: entryDir=0(从左来)→出口 270(向上)，物品 0.98 位于上边出口附近
  const cornerLR = seg({ isCorner: true, entryDir: 0, direction: 270 });
  assert(hit(cornerLR, pos(10, 10), 0.98, 10, 9), 'c3 转角物品出弯 → 上方直格被占据');
  assert(!hit(cornerLR, pos(10, 10), 0.5, 9, 10), 'c3b 弧中段不波及左侧邻格');
}
{
  // c4 端口预约延伸: feeder 在存货口下方，progress=1.25 已走进门口格 0.25 格深处
  const feeder = seg({ isCorner: true, entryDir: 0, direction: 270 });
  assert(hit(feeder, pos(12, 8), 1.25, 12, 7), 'c4 预约延伸进入门口格 → 该格被占据');
}
{
  // c5 离开连续性: 翻转瞬间物品圆包络同时压住新旧两格 —— 两格此刻都显示"物品"、
  // 都不出指针，不变量（每格二选一）依旧成立；走深后原格恢复指针显示。
  const up = seg({ direction: 270 });
  const pHead = pos(31, 34);
  assert(hit(up, pHead, 1.05, 31, 33), 'c5a 翻转后在新格浅处 → 新格被占据');
  assert(hit(up, pHead, 1.05, 31, 34), 'c5b 同刻原格仍在圆包络内 → 原格也显示物品(不出指针)');
  assert(!hit(up, pHead, 1.5, 31, 34), 'c5c 走深后原格脱离包络 → 原格指针恢复');
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
