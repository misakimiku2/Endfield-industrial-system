// 传送带物品世界坐标复刻 + 格级像素占据判定 — 2026-08-27（v7"每格二选一"像素互斥）
//
// 背景: 物品与指针的贴图都会越过段边界——物品中心行进到边界时前半身伸入邻格约
// 半张贴图（ITEM_VISUAL_SIZE/2=16px），指针尖端越界约 8px，两者相位互相独立。
// 仅按"本段 items 非空即隐藏指针"（v6 按段判定）时，物品跨格瞬态会与**邻格空段**
// 的流动指针像素共存，读作"指针和物品同格"（用户直线带实拍复现）。用户重申不变量:
// **每一格传送带画面上只允许呈现指针或物品其中之一**。
// 故指针渲染器在按段判定之外叠加**格级像素占据判定**: 任一物品渲染位置（圆包络）
// 压到本格矩形 → 本格指针让位隐藏（硬切、无渐变）；物品离开即恢复。
//
// 本模块纯几何、无 Pixi 依赖，供 BeltPointerRenderer 与 verify 脚本共用。
// ⚠️ itemWorldPosOnSegment 与 BeltItemRenderer.itemTransform **逐字同源**（直段从
// 入口边起算；转角弧 progress≤1，超出沿出口方向直线延伸）。教训见
// doc/implementation-phase-2.md 第四轮修订: 复用渲染位置必须逐字对照既有实现，
// "等价的向量公式"在 progress 从哪条边起算这种约定上并不等价——改动任一侧必须
// 同步另一侧并由 scripts/verify-belt-pointer-exclusivity.ts 的一致性断言兜底。

import type { BeltSegmentComp } from '../components/BeltSegmentComp.ts';
import type { Position } from '../components/Position.ts';
import type { Direction } from '../components/BuildingComp.ts';
import { directionVector } from '../systems/belt/BeltPathGeometry.ts';
import { CELL_SIZE } from './constants.ts';

/** 物品探测半径 = 贴图长边一半（0.5 格 / 2 = 16px）+ 余量 4px。余量吸收转角弧的
 *  中点弦近似误差（~7% 格宽）与帧间插值残差；同时保证停在格中心的排队物品
 *  （圆缘距边界 32−20=12px < 0 才触发，中心距 32px）不会误伤相邻格指针。 */
export const ITEM_PROBE_RADIUS = CELL_SIZE * 0.25 + 4;

/**
 * 物品在某段上的渲染世界坐标（x/y 与 BeltItemRenderer.itemTransform 完全一致）。
 * @param renderProgress 渲染插值后的 progress（item.progress + alpha*(item.delta||0)，
 *                       可为 >1 的端口预约延伸值）。
 */
export function itemWorldPosOnSegment(
  seg: Pick<BeltSegmentComp, 'isCorner' | 'entryDir' | 'direction'>,
  pos: Pick<Position, 'x' | 'y'>,
  renderProgress: number,
): { x: number; y: number } {
  if (seg.isCorner && seg.entryDir !== undefined) {
    // 转角弧仅在 0~1 定义，超出部分 = 弧终点（出口边中心）沿出口方向直线延伸
    // （BeltItemRenderer T2.6 修订同款）。弧数学与 pointer/item 的 pivot 圆同源。
    const arc = cornerArcOffset(seg.entryDir, seg.direction, Math.min(renderProgress, 1));
    let x = pos.x + CELL_SIZE / 2 + arc.x;
    let y = pos.y + CELL_SIZE / 2 + arc.y;
    if (renderProgress > 1) {
      const dv = directionVector(seg.direction);
      const extra = (renderProgress - 1) * CELL_SIZE;
      x += dv.x * extra;
      y += dv.y * extra;
    }
    return { x, y };
  }
  // 直段: 从入口边起算线性插值（dir 0/90 沿正向，180/270 沿负向），>1 自然延伸出段
  const offset = renderProgress * CELL_SIZE;
  switch (seg.direction) {
    case 0:   return { x: pos.x + offset,        y: pos.y + CELL_SIZE / 2 };
    case 90:  return { x: pos.x + CELL_SIZE / 2, y: pos.y + offset };
    case 180: return { x: pos.x + CELL_SIZE - offset, y: pos.y + CELL_SIZE / 2 };
    case 270: return { x: pos.x + CELL_SIZE / 2, y: pos.y + CELL_SIZE - offset };
  }
}

/** 转角四分之一圆弧偏移（相对格中心，世界像素；不含旋转）。entryDir=进入方向。 */
function cornerArcOffset(
  entryDir: Direction,
  exitDir: Direction,
  progress: number,
): { x: number; y: number } {
  // 进入边的边缘向量（相对格中心，单位=半格 0.5；屏幕坐标 y 向下）
  let eX = 0, eY = 0;
  if (entryDir === 270) eY = 0.5;        // up: 进入边在下边
  else if (entryDir === 90) eY = -0.5;   // down: 进入边在上边
  else if (entryDir === 180) eX = 0.5;   // left: 进入边在右边
  else if (entryDir === 0) eX = -0.5;    // right: 进入边在左边
  // 出口边的边缘向量
  let xX = 0, xY = 0;
  if (exitDir === 270) xY = -0.5;        // up: 出口边在上边
  else if (exitDir === 90) xY = 0.5;     // down: 出口边在下边
  else if (exitDir === 180) xX = -0.5;   // left: 出口边在左边
  else if (exitDir === 0) xX = 0.5;      // right: 出口边在右边
  // 圆心 = 两边缘向量之和；起始切向 = -出口边向量（指向格内）
  const pivotX = eX + xX;
  const pivotY = eY + xY;
  const startAngle = Math.atan2(-xY, -xX);
  const dirIdx = (d: Direction) => (d === 270 ? 0 : d === 0 ? 1 : d === 90 ? 2 : 3);
  const diff = (dirIdx(exitDir) - dirIdx(entryDir) + 4) % 4;
  const deltaAngle = diff === 3 ? -Math.PI / 2 : Math.PI / 2;
  const currentAngle = startAngle + progress * deltaAngle;
  return {
    x: (pivotX + 0.5 * Math.cos(currentAngle)) * CELL_SIZE,
    y: (pivotY + 0.5 * Math.sin(currentAngle)) * CELL_SIZE,
  };
}

/** 圆（物品贴图圆形包络近似）与矩形是否相交（含边界相切）。 */
export function circleIntersectsRect(
  cx: number, cy: number, r: number,
  rx: number, ry: number, rw: number, rh: number,
): boolean {
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}
