// 传送带链操作 — T2.0 阶段2 链管理（查询/整链删/单段删）
// 依据: implementation-phase-2.md T2.0 §链管理、§删除规则
//
// 纯函数（对 World 取数/改组件），无类状态。供 main.ts（Delete/Shift+Delete）
// 与 SelectionSystem（链查询）复用。
//
// 设计要点:
//   - 单段删除的「下游变断头链」用**空间连通性**判定上下游，不依赖 segmentIndex——
//     后者在断头延长时会与原链索引碰撞（BeltCreationSystem.trySelectStart 把 fullPath
//     重置为 []，新段 segmentIndex 从 0 重新计数）。用方向几何重建拓扑更鲁棒。
//   - 拓扑端点: toCell   = cell + directionVector(出方向)
//                fromCell = cell - directionVector(进入方向)
//     进入方向 = 转角段 entryDir；直段 = 出方向（item 沿出方向流入）。
//   - 链为简单路径（防穿模 + 创建约束保证无环、无分支），每段至多一进一出。

import type { World, EntityHandle } from '../../ECS';
import type { OccupancyMap } from '../../world/OccupancyMap';
import type { Position } from '../../components/Position';
import type { BeltSegmentComp } from '../../components/BeltSegmentComp';
import type { Direction } from '../../components/BuildingComp';
import { directionVector } from './BeltPathGeometry';
import { CELL_SIZE } from '../../render/constants';

/** Direction 反向（0↔180, 90↔270）。 */
function oppositeDirection(dir: Direction): Direction {
  return (((dir + 180) % 360) as Direction);
}

/** cell → 字符串 key（Map 索引用）。 */
const cellKey = (c: { x: number; y: number }): string => `${c.x},${c.y}`;

/** 取段的网格坐标。Position 必为 CELL_SIZE 整数倍（网格吸附），round 防御浮点误差。 */
function segmentCell(world: World, handle: EntityHandle): { x: number; y: number } {
  const pos = world.getComponent<Position>(handle, 'Position')!;
  return { x: Math.round(pos.x / CELL_SIZE), y: Math.round(pos.y / CELL_SIZE) };
}

/** 取段的「进入方向」（转角段=entryDir；直段=出方向）。 */
function segmentIncomingDir(seg: BeltSegmentComp): Direction {
  return seg.isCorner && seg.entryDir !== undefined ? seg.entryDir : seg.direction;
}

/** 拆链生成的断头链计数器（与 BeltCreationSystem.chainCounter 独立，前缀区分防撞）。 */
let splitChainCounter = 0;

/** 生成新断头链 chainId。 */
function newSplitChainId(): string {
  return `chain-split-${Date.now()}-${++splitChainCounter}`;
}

/** 段的空间拓扑端点。 */
interface SegmentTopology {
  handle: EntityHandle;
  cell: { x: number; y: number };
  /** 上游邻格（item 来源方向上的相邻 cell）。 */
  fromCell: { x: number; y: number };
  /** 下游邻格（item 去向方向上的相邻 cell）。 */
  toCell: { x: number; y: number };
}

/** 计算一个段的拓扑端点（不修改世界）。seg/cell 由调用方提供。 */
function topologyOf(
  seg: BeltSegmentComp,
  cell: { x: number; y: number },
  handle: EntityHandle,
): SegmentTopology {
  const inVec = directionVector(segmentIncomingDir(seg));
  const outVec = directionVector(seg.direction);
  return {
    handle,
    cell,
    fromCell: { x: cell.x - inVec.x, y: cell.y - inVec.y },
    toCell: { x: cell.x + outVec.x, y: cell.y + outVec.y },
  };
}

/**
 * 查询同链所有段。
 * @returns 段 handle 列表（顺序任意）；链不存在时为空数组。
 */
export function queryChain(world: World, chainId: string): EntityHandle[] {
  const result: EntityHandle[] = [];
  for (const handle of world.query('BeltSegmentComp')) {
    const seg = world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp')!;
    if (seg.chainId === chainId) result.push(handle);
  }
  return result;
}

/**
 * 删除整条链: 销毁全部段 + 释放每格占用。
 * @returns 删除的段数（0 = 链不存在）
 */
export function deleteChain(world: World, occupancy: OccupancyMap, chainId: string): number {
  const handles = queryChain(world, chainId);
  for (const handle of handles) {
    const cell = segmentCell(world, handle);
    occupancy.release(cell.x, cell.y);
    world.destroyEntity(handle);
  }
  return handles.length;
}

/**
 * 删除单段: 销毁该段 + 释放占用，并把原链按空间连通性重拆为若干独立链。
 *
 * 规则（文档 §删除规则: 删中间段 → 下游链变为断头链）:
 *   - 含原链头的连通分量保留原 chainId（上游）；
 *   - 其余连通分量各分配新 chainId（下游断头链）；
 *   - 每个分量按路径顺序重排 segmentIndex(0..n)，末段置 isTail=true，其余 isTail=false。
 *
 * 边界:
 *   - 删头段 → 无分量含原头，全部重拆为新断头链；
 *   - 删尾段 → 上游保留原 chainId，末段置 tail；
 *   - 链长 1 → 删空，无后续操作。
 *
 * 幂等/防御: handle 非传送带段（无 BeltSegmentComp）→ 直接 return。
 */
export function deleteSegment(world: World, occupancy: OccupancyMap, handle: EntityHandle): void {
  const seg = world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp');
  if (!seg) return;
  const chainId = seg.chainId;

  // 1. 原链拓扑全集（含被删段，用于精确判定「原链头」与连通性）
  const allHandles = queryChain(world, chainId);
  const topoAll: SegmentTopology[] = [];
  for (const h of allHandles) {
    const s = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!;
    topoAll.push(topologyOf(s, segmentCell(world, h), h));
  }

  // 2. 销毁被删段 + 释放占用
  const deletedCell = segmentCell(world, handle);
  occupancy.release(deletedCell.x, deletedCell.y);
  world.destroyEntity(handle);

  // 剩余段 = topoAll 中仍存活的
  const remaining = topoAll.filter((t) => world.isAlive(t.handle));
  if (remaining.length === 0) return;

  // 3. 原链头: fromCell 不在原链任何段 cell 中（无前驱；含被删段 cell 比较）
  const allCellKeys = new Set(topoAll.map((t) => cellKey(t.cell)));
  const headTopo = topoAll.find((t) => !allCellKeys.has(cellKey(t.fromCell))) ?? null;
  const originalHead = headTopo?.handle ?? null;
  // 若被删段就是原头 → originalHead 已销毁，下方「含原头的分量」判定自然不成立 → 全部重拆。

  // 4. 连通分量（无向: 后继 toCell + 前驱 fromCell 都可走）
  const byCell = new Map<string, SegmentTopology>();
  for (const t of remaining) byCell.set(cellKey(t.cell), t);
  const visited = new Set<EntityHandle>();
  const components: SegmentTopology[][] = [];
  for (const t of remaining) {
    if (visited.has(t.handle)) continue;
    const comp: SegmentTopology[] = [];
    const stack = [t];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur.handle)) continue;
      visited.add(cur.handle);
      comp.push(cur);
      const succ = byCell.get(cellKey(cur.toCell));
      if (succ && !visited.has(succ.handle)) stack.push(succ);
      const pred = byCell.get(cellKey(cur.fromCell));
      if (pred && !visited.has(pred.handle)) stack.push(pred);
    }
    components.push(comp);
  }

  // 5. 每个分量: 找分量头 → 沿后继排序 → 决定 chainId → 重写 segmentIndex/isTail
  for (const comp of components) {
    // 分量头: fromCell 不在分量内（分量内的简单路径起点）
    const compCellKeys = new Set(comp.map((t) => cellKey(t.cell)));
    let head = comp.find((t) => !compCellKeys.has(cellKey(t.fromCell)));
    if (!head) head = comp[0]; // 防御兜底（环路不会出现，但稳妥起见）

    // 沿后继链顺序排列
    const ordered: SegmentTopology[] = [];
    const compSeen = new Set<EntityHandle>();
    let cur: SegmentTopology | undefined = head;
    while (cur && !compSeen.has(cur.handle)) {
      compSeen.add(cur.handle);
      ordered.push(cur);
      cur = byCell.get(cellKey(cur.toCell));
    }

    // 含原链头的分量保留原 chainId；否则分配新断头链 chainId
    const keepOriginal =
      originalHead !== null && ordered.some((t) => t.handle === originalHead);
    const newChainId = keepOriginal ? chainId : newSplitChainId();

    for (let i = 0; i < ordered.length; i++) {
      const t = ordered[i];
      if (!world.isAlive(t.handle)) continue;
      const s = world.getComponent<BeltSegmentComp>(t.handle, 'BeltSegmentComp')!;
      world.addComponent(t.handle, 'BeltSegmentComp', {
        ...s,
        chainId: newChainId,
        segmentIndex: i,
        isTail: i === ordered.length - 1,
      });
    }
  }
}

/** oppositeDirection 的导出（仅测试/调试用）。 */
export const __oppositeDirection = oppositeDirection;
