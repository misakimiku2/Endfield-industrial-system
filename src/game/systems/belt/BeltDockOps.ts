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
// 吸附规则 applyDockSnap:
//   · mouse 在**输入端口格**上 → 路径截断到供给格（倒数第二格），末段方向 = 供给格→端口。
//     拖到设备上也能对接，不再整条染红（用户实测的主要卡点）。
//   · mouse 在**供给格**（端口四邻格）上 → 末段方向覆盖为指向端口（覆盖默认尾向），
//     落盘即保证 findFeederBelt 判定成立。
//   · 吸附会产生 180° 折返（进入方向与指向端口方向相反，如单格带从背离侧进入）时
//     放弃吸附——传送带只有直段和 90° 转角，180° U 形不是合法带型。
//
// 本模块不依赖 World/渲染（纯几何），单测直跑（DD-011 先例: BufferOps/ProductionOps）。

import type { Direction } from '../../components/BuildingComp.ts';
import { directionVector } from './BeltPathGeometry.ts';
import { directionBetween, type GridCell } from './BeltPathfinding.ts';

/** 端口格索引的键（与 IntakeOps.buildBeltCellIndex 同一约定）。 */
export const portKey = (cell: { x: number; y: number }): string => `${cell.x},${cell.y}`;

/** 一次吸附决策: 末段所在格 + 覆盖后的出方向（指向端口）。 */
export interface DockSnap {
  cell: GridCell;
  dir: Direction;
}

/** applyDockSnap 的结果: 截断后的路径 + 吸附决策（null = 无吸附）。 */
export interface DockSnapResult {
  raw: GridCell[];
  snap: DockSnap | null;
}

/** 相反方向（180° 折返判定用）。 */
function opposite(dir: Direction): Direction {
  if (dir === 0) return 180;
  if (dir === 180) return 0;
  if (dir === 90) return 270;
  return 90;
}

/** 方向遍历序（与 IntakeOps.findFeederBelt 一致: 右/下/左/上，多口命中时取首个）。 */
const DOCK_DIRS: readonly Direction[] = [0, 90, 180, 270];

/**
 * 供给格判定: cell 的四邻格中有输入端口格？
 * @param ports 输入端口格索引（IntakeOps.collectInputPortCells）
 * @returns 命中的端口格 + cell 指向它的方向；无则 null。
 */
export function dockTargetAt(
  cell: GridCell,
  ports: Map<string, GridCell>,
): { portCell: GridCell; dir: Direction } | null {
  for (const k of DOCK_DIRS) {
    const dv = directionVector(k);
    const portCell = ports.get(portKey({ x: cell.x + dv.x, y: cell.y + dv.y }));
    if (portCell !== undefined) return { portCell, dir: k };
  }
  return null;
}

/** 吸附格的进入方向: 首个带格（路径 idx 1，前格是锚点/端口格）用链首继承方向 startDir，
 *  其余格取前一格位移（与 computePathCells/computeTurnInfos 的 incoming 口径一致）。 */
function incomingDirOf(path: GridCell[], idx: number, startDir: Direction): Direction | null {
  if (idx <= 1) return startDir;
  return directionBetween(path[idx - 1], path[idx]);
}

/**
 * 预览路径的终点吸附（T2.16 需求"末段方向吸附"的核心）。
 * @param raw 寻路结果（含起点格，末格 = mouseGrid——findPath/动量 L 形都保证终于终点格）
 * @param mouseGrid 当前鼠标格
 * @param ports 输入端口格索引
 * @param startDir 链首继承方向（起点端口朝向 / 延长时上一尾段出方向）
 */
export function applyDockSnap(
  raw: GridCell[],
  mouseGrid: GridCell,
  ports: Map<string, GridCell>,
  startDir: Direction,
): DockSnapResult {
  if (raw.length < 2) return { raw, snap: null };

  // ① mouse 在输入端口格上 → 截断到供给格，末段指向端口。
  //    要求截断后仍有至少 1 个带格（raw ≥ 3: [起点, 供给格, 端口格] 起步），
  //    否则供给格 = 起点格（锚点/原尾段），无可落盘新段，不吸附（路径含端口格 → 染红）。
  if (raw.length >= 3 && ports.has(portKey(mouseGrid))) {
    const supply = raw[raw.length - 2];
    const dir = directionBetween(supply, mouseGrid);
    if (dir !== null) {
      if (incomingDirOf(raw, raw.length - 2, startDir) !== opposite(dir)) {
        return { raw: raw.slice(0, -1), snap: { cell: supply, dir } };
      }
      return { raw, snap: null }; // 180° 折返 → 放弃（原路径含端口格，checkPathValid 染红提示）
    }
  }

  // ② mouse 在供给格上 → 末段方向覆盖为指向端口。
  const target = dockTargetAt(mouseGrid, ports);
  if (target !== null && incomingDirOf(raw, raw.length - 1, startDir) !== opposite(target.dir)) {
    return { raw, snap: { cell: { x: mouseGrid.x, y: mouseGrid.y }, dir: target.dir } };
  }
  return { raw, snap: null };
}

/**
 * 把吸附方向写到路径格序列的末格（末格须与吸附格重合，防错位写入）。
 * computePathCells 的默认尾向是"沿用上一格方向"——吸附后须覆盖，随后
 * computeTurnInfos 依 incoming/outgoing 自然得出直段或 90° 转角。
 */
export function applySnapToCells<T extends { x: number; y: number; direction: Direction }>(
  cells: T[],
  snap: DockSnap | null,
): void {
  if (!snap || cells.length === 0) return;
  const last = cells[cells.length - 1];
  if (last.x === snap.cell.x && last.y === snap.cell.y) last.direction = snap.dir;
}

/** 预览末段的对接信息（渲染层输入端口高亮用）。 */
export interface DockInfo {
  /** 预览末格四邻中的输入端口格（候选——"够得着"）。 */
  targets: GridCell[];
  /** 末格 + 末段方向命中的端口格（落盘即 findFeederBelt 成立——"将连接"）。 */
  confirmed: GridCell[];
}

/**
 * 由预览末格与末段方向得出对接信息（T2.16 需求"输入端口终点高亮/将连接确认"）。
 * targets = 末格四邻全部输入端口格；confirmed = 末段方向指向的那个端口格。
 */
export function dockInfoOf(
  tail: GridCell,
  tailDir: Direction,
  ports: Map<string, GridCell>,
): DockInfo {
  const targets: GridCell[] = [];
  const confirmed: GridCell[] = [];
  for (const k of DOCK_DIRS) {
    const dv = directionVector(k);
    const portCell = ports.get(portKey({ x: tail.x + dv.x, y: tail.y + dv.y }));
    if (portCell === undefined) continue;
    targets.push(portCell);
    if (k === tailDir) confirmed.push(portCell);
  }
  return { targets, confirmed };
}
