// 传送带几何/渲染数学 — T2.0 阶段1
// 移植自旧 Flutter 项目 transport_belt_renderer.dart 的方向判断与转角数学。
//
// 本模块为纯函数，无副作用，供 BeltCreationSystem（预览/落盘）、RenderSystem（提交后渲染）、
// BeltPointerRenderer（pointer 流动）三方共享，保证「预览 ↔ 落盘 ↔ 渲染」三方一致。
//
// 方向约定（与 BuildingComp.Direction 一致）：
//   0°   = right (+x)
//   90°  = down  (+y)
//   180° = left  (-x)
//   270° = up    (-y)

import type { Direction } from '../../components/BuildingComp';

// ───────────────────────── 方向基础工具 ─────────────────────────

/** 方向 → 单位向量。 */
export function directionVector(dir: Direction): { x: number; y: number } {
  switch (dir) {
    case 0:   return { x: 1, y: 0 };
    case 90:  return { x: 0, y: 1 };
    case 180: return { x: -1, y: 0 };
    case 270: return { x: 0, y: -1 };
  }
}

/** 由位移(dx,dy)推断方向（dx/dy 之一非零）。 */
export function offsetToDirection(dx: number, dy: number): Direction {
  if (dx > 0) return 0;
  if (dx < 0) return 180;
  if (dy > 0) return 90;
  return 270;
}

/**
 * 方向 → 序号，与旧项目一致：up=0, right=1, down=2, left=3。
 * 用于 CCW 判定（(outIdx - inIdx + 4) % 4 === 3）。
 */
function directionToIndex(dir: Direction): number {
  switch (dir) {
    case 270: return 0; // up
    case 0:   return 1; // right
    case 90:  return 2; // down
    case 180: return 3; // left
  }
}

/**
 * 方向 → 弧度角，与旧项目 _directionAngle 一致：right=0, down=π/2, left=π, up=3π/2。
 * 注意：这是「屏幕坐标系角度」（y 向下），用于把默认朝右的资源旋转到目标方向。
 */
export function directionAngle(dir: Direction): number {
  switch (dir) {
    case 0:   return 0;
    case 90:  return Math.PI / 2;
    case 180: return Math.PI;
    case 270: return (3 * Math.PI) / 2;
  }
}

// ───────────────────────── 转角方向判断 ─────────────────────────

/** 转角信息。 */
export interface CellTurnInfo {
  /** 是否为转角格（入方向 ≠ 出方向）。 */
  isTurn: boolean;
  /** 进入该格的方向（来自上游格）。 */
  incomingDir: Direction;
  /** 离开该格的方向（去往下游格）。 */
  outgoingDir: Direction;
  /** 是否为逆时针转弯（用于决定渲染公式）。 */
  isCCW: boolean;
}

/**
 * 判断 path[index] 是直线段还是转弯点。
 * 移植自旧项目 _getCellTurnInfo / _getCellDirection。
 *
 * @param path         完整路径格子序列（grid 坐标）。
 * @param index        当前判断的格子索引。
 * @param incomingDir  链首格继承的进入方向（仅 index===0 且有源端时使用）。
 * @param outgoingDir  链尾格的强制离开方向（仅 index===path.length-1 且单格链时使用）。
 */
export function getCellTurnInfo(
  path: { x: number; y: number }[],
  index: number,
  incomingDir?: Direction,
  outgoingDir?: Direction,
): CellTurnInfo {
  // —— 单格链 ——
  if (path.length === 1) {
    if (incomingDir !== undefined && outgoingDir !== undefined && incomingDir !== outgoingDir) {
      return makeTurn(incomingDir, outgoingDir);
    }
    const dir = outgoingDir ?? 0;
    return { isTurn: false, incomingDir: dir, outgoingDir: dir, isCCW: false };
  }

  // —— 首格 ——
  if (index === 0) {
    const next = path[1];
    const cur = path[0];
    const outDir = offsetToDirection(next.x - cur.x, next.y - cur.y);
    if (incomingDir !== undefined) {
      if (incomingDir === outDir) {
        return { isTurn: false, incomingDir, outgoingDir: outDir, isCCW: false };
      }
      return makeTurn(incomingDir, outDir);
    }
    return { isTurn: false, incomingDir: outDir, outgoingDir: outDir, isCCW: false };
  }

  // —— 尾格 ——
  if (index === path.length - 1) {
    const prev = path[index - 1];
    const cur = path[index];
    const inDir = offsetToDirection(cur.x - prev.x, cur.y - prev.y);
    if (outgoingDir !== undefined && inDir !== outgoingDir) {
      return makeTurn(inDir, outgoingDir);
    }
    return { isTurn: false, incomingDir: inDir, outgoingDir: inDir, isCCW: false };
  }

  // —— 中间格 ——
  const prev = path[index - 1];
  const cur = path[index];
  const next = path[index + 1];
  const inDir = offsetToDirection(cur.x - prev.x, cur.y - prev.y);
  const outDir = offsetToDirection(next.x - cur.x, next.y - cur.y);
  if (inDir === outDir) {
    return { isTurn: false, incomingDir: inDir, outgoingDir: outDir, isCCW: false };
  }
  return makeTurn(inDir, outDir);
}

/** 由入/出方向构造一个转角信息，并判定 CW/CCW。 */
function makeTurn(incomingDir: Direction, outgoingDir: Direction): CellTurnInfo {
  const inIdx = directionToIndex(incomingDir);
  const outIdx = directionToIndex(outgoingDir);
  const diff = (outIdx - inIdx + 4) % 4;
  return { isTurn: true, incomingDir, outgoingDir, isCCW: diff === 3 };
}

/**
 * 直接由入/出方向对计算一格的转角信息（无需路径上下文）。
 * 供预览/落盘在已知方向对时使用，避免路径索引推导的歧义。
 *
 * @param incomingDir 进入该格的方向（来自上游段的出方向）。
 * @param outgoingDir 离开该格的方向（该格自身的出方向）。
 */
export function turnInfoFromDirections(
  incomingDir: Direction,
  outgoingDir: Direction,
): CellTurnInfo {
  if (incomingDir === outgoingDir) {
    return { isTurn: false, incomingDir, outgoingDir, isCCW: false };
  }
  return makeTurn(incomingDir, outgoingDir);
}

/**
 * 取一格的「主流向」——用于直段的纹理旋转。
 * 移植自旧项目 _getCellDirection：优先看下游，再看上游。
 */
export function getCellDirection(
  path: { x: number; y: number }[],
  index: number,
  forcedDirection?: Direction,
): Direction {
  if (forcedDirection !== undefined && path.length === 1) return forcedDirection;
  if (index < path.length - 1) {
    const cur = path[index];
    const next = path[index + 1];
    return offsetToDirection(next.x - cur.x, next.y - cur.y);
  }
  if (index > 0) {
    const prev = path[index - 1];
    const cur = path[index];
    return offsetToDirection(cur.x - prev.x, cur.y - prev.y);
  }
  return 0;
}

// ───────────────────────── 纹理旋转/镜像 ─────────────────────────

/**
 * 直段纹理旋转角（弧度）。
 * Transport_Belt_Move.svg 默认朝下（黄色带纵向），因此：
 *   down(90)  → 0
 *   left(180) → -π/2
 *   up(270)   → π
 *   right(0)  → π/2
 */
export function beltTextureRotation(dir: Direction): number {
  switch (dir) {
    case 0:   return Math.PI / 2;
    case 90:  return 0;
    case 180: return -Math.PI / 2;
    case 270: return Math.PI;
  }
}

/** 转角纹理变换结果。 */
export interface CornerTransform {
  /** 旋转角（弧度）。 */
  rotation: number;
  /** 是否需要水平镜像（CCW 转弯需要）。 */
  mirrorH: boolean;
}

/**
 * 转角纹理变换 — CW/CCW 双公式。
 * 移植自旧项目 _drawSvgCellAtOrigin 的转弯分支：
 *   CW : rotation = directionAngle(outgoingDir);            mirrorH = false
 *   CCW: rotation = (directionAngle(outgoingDir) - π + 2π) % 2π; mirrorH = true
 *
 * Transport_Belt_rotate.svg 默认是「下→右」转角（从下方进入、向右转出，外凸在右下）。
 * CW 公式把它旋转到目标出方向；CCW 公式用「出方向反向旋转 + 水平镜像」覆盖另一半转弯象限。
 */
export function beltCornerTransform(entryDir: Direction, exitDir: Direction): CornerTransform {
  const outAngle = directionAngle(exitDir);
  const info = makeTurn(entryDir, exitDir);
  if (info.isCCW) {
    const rotation = ((outAngle - Math.PI + 2 * Math.PI) % (2 * Math.PI));
    return { rotation, mirrorH: true };
  }
  return { rotation: outAngle, mirrorH: false };
}
