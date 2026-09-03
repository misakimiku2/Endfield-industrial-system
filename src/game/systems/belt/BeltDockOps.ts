// 传送带终点对接 — T2.16 纯逻辑模块（终点吸附/端口候选判定）
// 依据: implementation-phase-2.md T2.16（2026-08-24 用户实测: 拖带到设备格整条染红、
//       末段方向不指向端口时物品默默停在带尾——"连不上设备"无任何反馈）
//
// 背景: T2.6 连接判定 findFeederBelt 是隐式几何——末段须落在输入端口**相邻格（供给格）**
//   且方向**指向端口**。BeltCreationSystem 的寻路只走到鼠标格: 输入端口格被设备占用不可
//   放置（拖上去整条预览染红），末段方向默认"沿用上一格方向"（从侧面接近时指向侧面）。
//   本模块把"哪些格是对接目标、末段如何吸附"变成显式计算，供 BeltCreationSystem
//   （预览吸附/落盘）与 PortHighlightRenderer（端口高亮）共用，端口格索引由
//   IntakeOps.collectInputPortCells 提供（与 MachineSystem 吸入判定同一来源）。
//
// 对接规则（2026-09-02 三轮修订——**端口重定向**）:
//   · mouse 悬停在**输入端口格**上 → 寻路目标重定向到该端口的**朝向侧供给格**
//     （端口格 + outward 向量），并吸附末段方向 = 逆朝向指向端口。从任意方向拖到
//     端口上（含侧方横穿接近）都会自动找最近路径经供给格接入，不再恒红：侧方进入
//     供给格 → 末段 90° 拐向端口（转角），下方进入 → 直段。点击端口格 = 唯一对接触发手势。
//   · 供给格被占/不可放置 → 路径终于供给格，由 checkPathValid 染红（"接不上"反馈）。
//
// 本模块不依赖 World/渲染（纯几何），单测直跑（DD-011 先例: BufferOps/ProductionOps）。

import type { Direction } from '../../components/BuildingComp.ts';
import { directionVector } from './BeltPathGeometry.ts';
import type { GridCell } from './BeltPathfinding.ts';
import type { PortCell } from '../PortGeometry.ts';

/** 端口格索引的键（与 IntakeOps.buildBeltCellIndex 同一约定）。 */
export const portKey = (cell: { x: number; y: number }): string => `${cell.x},${cell.y}`;

/** 一次吸附决策: 末段所在格 + 覆盖后的出方向（指向端口）。 */
export interface DockSnap {
  cell: GridCell;
  dir: Direction;
}

/** 相反方向（180° 折返判定用）。 */
function opposite(dir: Direction): Direction {
  if (dir === 0) return 180;
  if (dir === 180) return 0;
  if (dir === 90) return 270;
  return 90;
}

/**
 * 端口重定向（2026-09-02 三轮修订）: mouse 悬停在**输入端口格**上时，寻路目标改为
 * 该端口**朝向侧供给格**，并给出吸附决策（末段方向 = 逆朝向指向端口）。
 * 旧版把端口格本身作为寻路终点再截断——朝向侧规则收紧后侧向进入无法吸附（恒红）；
 * 重定向后"从任意方向拖到端口上"都自动找最近路径接到供给格，末段拐向端口。
 * 供给格上方恒为被占端口格 → 路径不可能从端口侧进入供给格 → 吸附不会产生 180° 折返
 * （侧方进入 → 90° 转角，下方进入 → 直段）。
 */
export function dockRedirect(
  mouseGrid: GridCell,
  ports: Map<string, PortCell>,
): { target: GridCell; snap: DockSnap } | null {
  const portCell = ports.get(portKey(mouseGrid));
  if (portCell === undefined) return null;
  const odv = directionVector(portCell.outward);
  const target: GridCell = { x: portCell.x + odv.x, y: portCell.y + odv.y };
  return { target, snap: { cell: target, dir: opposite(portCell.outward) } };
}

/**
 * 把吸附方向写到路径格序列的末格（末格须与吸附格重合，防错位写入）。
 * computePathCells 的默认尾向是"沿用上一格方向"——吸附后须覆盖，随后
 * computeTurnInfos 依 incoming/outgoing 自然得出直段或 90° 转角。
 * 防御: 覆盖会产生 180° 折返（末段自然方向恰为吸附方向的反向）时不覆盖——
 * 端口重定向下供给格上方恒为被占端口格，正常不可达，此为异常拓扑兜底。
 */
export function applySnapToCells<T extends { x: number; y: number; direction: Direction }>(
  cells: T[],
  snap: DockSnap | null,
): void {
  if (!snap || cells.length === 0) return;
  const last = cells[cells.length - 1];
  if (last.x !== snap.cell.x || last.y !== snap.cell.y) return;
  if (last.direction === opposite(snap.dir)) return; // 180° 折返防御
  last.direction = snap.dir;
}

/** 预览末段的对接信息（渲染层输入端口高亮用）。 */
export interface DockInfo {
  /** 末格 + 末段方向命中的端口格（落盘即 findFeederBelt 成立——"将连接"）。 */
  confirmed: GridCell[];
}

/**
 * 由预览末格与末段方向得出对接信息。
 * 2026-09-02: 候选紫（targets 四邻端口"够得着"）已按用户要求移除——只保留
 * "将连接"绿: confirmed = 末段**从端口朝向侧供给格**指向的那个端口格
 * （与 findFeederBelt 同口径，侧向横穿不算）。
 */
export function dockInfoOf(
  tail: GridCell,
  tailDir: Direction,
  ports: Map<string, PortCell>,
): DockInfo {
  const confirmed: GridCell[] = [];
  const dv = directionVector(tailDir);
  const portCell = ports.get(portKey({ x: tail.x + dv.x, y: tail.y + dv.y }));
  if (portCell !== undefined) {
    // 末格须是端口朝向侧供给格（= 端口格 + outward 向量），否则是侧向横穿——不算确认
    const odv = directionVector(portCell.outward);
    if (tail.x === portCell.x + odv.x && tail.y === portCell.y + odv.y) {
      confirmed.push(portCell);
    }
  }
  return { confirmed };
}
