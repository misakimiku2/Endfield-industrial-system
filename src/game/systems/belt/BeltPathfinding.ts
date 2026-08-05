// 传送带寻路 — T2.0 阶段1
// 移植自旧 Flutter 项目 belt_direction_utils.dart 的双层寻路算法。
//
// 策略：先用「动量 L 形」启发式快速生成路径，若被阻挡则回退到 BFS 网格寻路绕障。
// 4 方向网格移动（曼哈顿走法），只产生直线段 + 90° 转角。
//
// 阶段1 简化（相对旧项目）：
//   - blocked set = 普通设备/越界格 + 当前已确认路径格，不含物流桥/已有传送带交叉的 dir-key 逻辑；
//   - 不处理多输入端口建筑的方向排序（阶段2+，依赖设备输入端口检测）。

import type { Direction } from '../../components/BuildingComp';
import { directionVector } from './BeltPathGeometry';

/** 网格坐标。 */
export interface GridCell {
  x: number;
  y: number;
}

/** findPath 的选项。 */
export interface FindPathOptions {
  /** 是否先走竖直腿（verticalFirst）。决定 L 形转弯更自然的方向。 */
  verticalFirst?: boolean;
  /** 起点的强制起始方向（如设备输出端口朝向）。路径首段必须沿此方向迈一步。 */
  startingDirection?: Direction;
  /** 起点首步允许的方向集合（如分流器禁止往输入端方向）。 */
  allowedDirections?: readonly Direction[];
}

/**
 * 阻挡判定函数：给定一格，返回 true 表示该格不可通行。
 * 统一处理「已被设备占用」「越界」「自身已确认路径」等情况。
 */
export type IsBlocked = (cell: GridCell) => boolean;

// ───────────────────────── 顶层接口 ─────────────────────────

/**
 * 双层寻路：动量 L 形优先，BFS 兜底。
 * @param isBlocked 阻挡判定（含设备占用/越界/自身路径交叉等）。
 * @returns 路径格子序列（含 start、end），找不到返回 null。
 *
 * 注意：终点格被占用**不作为失败条件**——路径仍会生成（终点格跳过阻挡检查），
 * 由调用方 checkPathValid 判定整条路径是否可放置（不可放置时整条染红提示）。
 */
export function findPath(
  start: GridCell,
  end: GridCell,
  isBlocked: IsBlocked,
  options: FindPathOptions = {},
): GridCell[] | null {
  if (start.x === end.x && start.y === end.y) return [start];

  const activeDirection = options.startingDirection;
  const allowedDirections = options.allowedDirections;

  // 1. 试动量 L 形路径
  const momentumPath = calculateMomentumPath(start, end, {
    verticalFirst: options.verticalFirst,
    startingDirection: activeDirection,
  });
  let momentumValid = true;
  for (let i = 0; i < momentumPath.length; i++) {
    // 起点格本身可能是端口/断头段（已占用），跳过
    if (i === 0) continue;
    // 终点格允许被占用（红色警示场景）
    const c = momentumPath[i];
    if (c.x === end.x && c.y === end.y) continue;
    if (isBlocked(c)) {
      momentumValid = false;
      break;
    }
  }
  // 验证首步方向是否在允许集合内（如分流器禁止往输入端方向）
  if (momentumValid && allowedDirections && momentumPath.length >= 2) {
    const firstStepDir = directionBetween(momentumPath[0], momentumPath[1]);
    if (firstStepDir !== null && !allowedDirections.includes(firstStepDir)) {
      momentumValid = false;
    }
  }
  if (momentumValid) return deduplicatePath(momentumPath);

  // 2. BFS 兜底
  const bfsPath = findPathBFS(start, end, isBlocked, {
    firstStepDirection: activeDirection,
    allowedDirections,
  });
  return bfsPath !== null ? deduplicatePath(bfsPath) : null;
}

// ───────────────────────── 动量 L 形路径 ─────────────────────────

/**
 * 动量 L 形路径。移植自旧项目 _calculateMomentumPath。
 *
 * 若有 startingDirection，先沿该方向迈一步（模拟设备端口出口的物理方向约束），
 * 再用「先走一条轴、再走另一条轴」的 L 形走到终点。
 */
export function calculateMomentumPath(
  start: GridCell,
  end: GridCell,
  opts: { verticalFirst?: boolean; startingDirection?: Direction } = {},
): GridCell[] {
  const { verticalFirst = false, startingDirection } = opts;
  const sx = start.x, sy = start.y;
  const ex = end.x, ey = end.y;

  if (sx === ex && sy === ey) return [start];

  const path: GridCell[] = [];
  let cx = sx;
  let cy = sy;

  // 起始端口方向约束：先沿 startingDirection 迈一步
  if (startingDirection !== undefined && (cx !== ex || cy !== ey)) {
    path.push({ x: cx, y: cy });
    const v = directionVector(startingDirection);
    cx += v.x;
    cy += v.y;
    if (cx === ex && cy === ey) {
      path.push({ x: ex, y: ey });
      return path;
    }
    path.push({ x: cx, y: cy });
    // 从新位置继续走剩余路径
  }

  if (verticalFirst) {
    // 先走竖直腿:推 (cx, y) 从 cy+dy 到 ey(含 ey=转角格);水平腿再从 cx 推水平
    if (cy !== ey) {
      const dy = ey > cy ? 1 : -1;
      for (let y = cy + dy; ; y += dy) {
        pushIfNew(path, { x: cx, y });
        if (y === ey) break;
      }
    }
    // 再走水平腿:推 (x, ey) 从 cx+dx 到 ex(含 ex=转角格或终点)
    if (cx !== ex) {
      const dx = ex > cx ? 1 : -1;
      for (let x = cx + dx; ; x += dx) {
        pushIfNew(path, { x, y: ey });
        if (x === ex) break;
      }
    }
  } else {
    // 先走水平腿:推 (x, cy) 从 cx+dx 到 ex(含 ex=转角格或终点)
    if (cx !== ex) {
      const dx = ex > cx ? 1 : -1;
      for (let x = cx + dx; ; x += dx) {
        pushIfNew(path, { x, y: cy });
        if (x === ex) break;
      }
    }
    // 再走竖直腿:推 (ex, y) 从 cy+dy 到 ey(含 ey);外层 pushIfNew 兜底(可能已被推)
    if (cy !== ey) {
      const dy = ey > cy ? 1 : -1;
      for (let y = cy + dy; ; y += dy) {
        pushIfNew(path, { x: ex, y });
        if (y === ey) break;
      }
    }
  }

  // 去重后确保终点入列（循环结束时 cx/cy 已等于 ex/ey，但路径里最后可能未含）
  pushIfNew(path, { x: ex, y: ey });
  return path;
}

/** 仅在 cell 与 path 末尾不同时才 push（避免相邻重复）。 */
function pushIfNew(path: GridCell[], cell: GridCell): void {
  const last = path[path.length - 1];
  if (!last || last.x !== cell.x || last.y !== cell.y) {
    path.push(cell);
  }
}

// ───────────────────────── BFS 寻路 ─────────────────────────

/** BFS 节点：坐标 + 进入该格的方向索引（-1 = 起点）。 */
interface BFSNode {
  x: number;
  y: number;
  /** 进入该格的移动方向索引：0=up,1=right,2=down,3=left；-1=起点无入方向。 */
  incomingDir: number;
}

// 0=up[0,-1], 1=right[1,0], 2=down[0,1], 3=left[-1,0]
const DIR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // up
  [1, 0],  // right
  [0, 1],  // down
  [-1, 0], // left
];

/** Direction → 方向索引（与 DIR_OFFSETS 对齐：up=0,right=1,down=2,left=3）。 */
function directionToIndex(dir: Direction): number {
  switch (dir) {
    case 270: return 0; // up
    case 0:   return 1; // right
    case 90:  return 2; // down
    case 180: return 3; // left
  }
}

/**
 * 4 方向网格 BFS。移植自旧项目 _findPathBFS。
 * @param isBlocked 阻挡判定（含设备占用/越界/自身路径交叉等）。起点格本身不判阻挡。
 * @returns 路径格子序列（含 start、end），找不到返回 null。
 */
export function findPathBFS(
  start: GridCell,
  end: GridCell,
  isBlocked: IsBlocked,
  opts: { firstStepDirection?: Direction; allowedDirections?: readonly Direction[] } = {},
): GridCell[] | null {
  const startKey = keyOf(start);
  const endKey = keyOf(end);

  if (startKey === endKey) return [start];
  // 注意：终点被占用不返回 null——允许到达被占终点(整条染红由调用方判定)

  const queue: BFSNode[] = [];
  // visited: cellKey → [parentCellKey, parentCell]（parentCellKey=null 表示起点）
  const visited = new Map<string, [string | null, GridCell]>();
  visited.set(startKey, [null, start]);
  queue.push({ x: start.x, y: start.y, incomingDir: -1 });

  let searched = 0;
  const MAX_SEARCH = 5000;

  while (queue.length > 0 && searched < MAX_SEARCH) {
    const node = queue.shift()!;
    const nodeKey = keyOf(node);
    searched++;

    if (nodeKey === endKey) {
      return reconstructPath(visited, end);
    }

    // 决定本节点允许的移动方向
    let allowedDirIndices: number[];
    if (nodeKey === startKey && opts.allowedDirections) {
      allowedDirIndices = opts.allowedDirections.map(directionToIndex);
      if (allowedDirIndices.length === 0) allowedDirIndices = [0, 1, 2, 3];
    } else if (nodeKey === startKey && opts.firstStepDirection !== undefined) {
      allowedDirIndices = [directionToIndex(opts.firstStepDirection)];
    } else {
      // 非起点节点: 同方向或 90° 转弯,不允许 180° 反向(传送带流动方向约束)
      if (node.incomingDir === -1) {
        allowedDirIndices = [0, 1, 2, 3];
      } else {
        allowedDirIndices = [
          node.incomingDir,
          (node.incomingDir + 1) % 4,
          (node.incomingDir + 3) % 4,
        ];
      }
    }

    for (const dirIdx of allowedDirIndices) {
      const d = DIR_OFFSETS[dirIdx];
      const nx = node.x + d[0];
      const ny = node.y + d[1];
      const neighbor: GridCell = { x: nx, y: ny };
      const nKey = `${nx},${ny}`;
      // 终点格允许被占用(红色警示场景),其余被阻挡格跳过。
      const isEnd = nx === end.x && ny === end.y;
      if (isBlocked(neighbor) && !isEnd) continue;
      if (visited.has(nKey)) continue;

      visited.set(nKey, [nodeKey, { x: node.x, y: node.y }]);
      queue.push({ x: nx, y: ny, incomingDir: dirIdx });
    }
  }

  return null;
}

/** 从 visited 回溯出路径（含 start、end）。 */
function reconstructPath(
  visited: Map<string, [string | null, GridCell]>,
  end: GridCell,
): GridCell[] {
  const path: GridCell[] = [];
  let curKey: string | null = keyOf(end);
  while (curKey !== null) {
    const entry = visited.get(curKey);
    if (!entry) break;
    const parts = curKey.split(',');
    path.push({ x: Number(parts[0]), y: Number(parts[1]) });
    curKey = entry[0];
  }
  return path.reverse();
}

// ───────────────────────── 工具 ─────────────────────────

/** 格 → blocked set 用的键。 */
export function keyOf(cell: { x: number; y: number }): string {
  return `${cell.x},${cell.y}`;
}

/** 由两格位移推断方向，无位移返回 null。 */
export function directionBetween(from: GridCell, to: GridCell): Direction | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  if (dx > 0) return 0;
  if (dx < 0) return 180;
  if (dy > 0) return 90;
  return 270;
}

/** 去除相邻重复格。 */
export function deduplicatePath(path: GridCell[]): GridCell[] {
  if (path.length < 2) return path;
  const result: GridCell[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const cur = path[i];
    if (prev.x !== cur.x || prev.y !== cur.y) {
      result.push(cur);
    }
  }
  return result;
}

/**
 * 判断最近一次锚点位移是否以竖直为主（用于决定 verticalFirst）。
 * 移植自旧项目 _isIncomingVertical：竖直位移绝对值 > 水平位移绝对值时为真。
 */
export function isIncomingVertical(anchors: GridCell[]): boolean {
  if (anchors.length < 2) return false;
  const prev = anchors[anchors.length - 2];
  const last = anchors[anchors.length - 1];
  return Math.abs(last.y - prev.y) > Math.abs(last.x - prev.x);
}
