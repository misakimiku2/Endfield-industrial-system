// 输入对接操作 — 传送带 → 设备输入端口吸入 (T2.6)
// 依据: implementation-phase-2.md T2.6、A9 logistics-spec.md §3.3(端口吸入)/§3.6(吸入副作用)/
//       §6.7(端口连接判定)、A8 production-system-spec.md §7 步骤2(输入物流)
//
// 纯逻辑模块 (DD-011，BufferOps/ProductionOps 先例): 判定"哪条传送带在喂哪个输入端口"
// 与"吸入一件物品到输入槽"，由 MachineSystem 每 Tick 对每台设备的每个输入端口调用。
//
// 连接判定 (A9 §6.7): 传送带段的末端格与设备某 Input Port 的 Cell 相邻，
//   且传送带方向"指向"设备（段格 + directionVector(direction) === 端口格）。
// 吸入触发 (A9 §3.3): 队首物品 progress ≥ STOP_MAX(0.5 格中心)。BeltSystem 对无下游带的
//   段尾物品钳制在同一位置——物品"停在设备门口"与"触发吸入"同点：槽满时物品停住，
//   槽腾出后停在门口的物品立即被吸入（堵塞→疏通恢复，A9 §3.5），无需额外状态。
// 吸入副作用 (A9 §3.6 三件套): 物品从段 items[] 移除 + 输入槽 count+1 + 空槽锁定类型
//   （后两者由 BufferOps.tryAcceptItem 完成，A8 §2.1 输入槽规则）。
// 节流 (A8 §4.1): 每个输入端口每 Tick 至多吸入 1 件（只取队首）。多端口轮询指针
//   (inputPollIndex) 按任务划分属 T2.10——本模块按端口定义序遍历，对当前全部
//   单输入槽设备行为等价（左→中→右按定义顺序依次尝试）。

import type { World, EntityHandle } from '../../ECS.ts';
import type { Position } from '../../components/Position.ts';
import type { BeltSegmentComp } from '../../components/BeltSegmentComp.ts';
import type { BuildingComp, Direction } from '../../components/BuildingComp.ts';
import type { BuildingDefinition } from '../../data/buildings.ts';
import { STOP_MAX } from '../BeltSystem.ts';
import { directionVector } from '../belt/BeltPathGeometry.ts';
import { rotatePort } from '../PortGeometry.ts';
import { tryAcceptItem } from './BufferOps.ts';
import { CELL_SIZE } from '../../render/constants.ts';

/** 吸入触发的队首 progress（= BeltSystem.STOP_MAX 格中心，A9 §3.3，两值必须同源）。 */
export const PORT_ENTER_PROGRESS = STOP_MAX;

/** 端口世界格（Grid 坐标）。 */
export interface PortCell {
  /** 端口定义（ports 数组内的原始引用）。 */
  port: BuildingDefinition['ports'][number];
  x: number;
  y: number;
}

/**
 * 计算设备全部**输入**端口的世界格（按定义顺序，即"左→中→右"连接序）。
 * 输出/液体端口不在其中（output 由 T2.7 处理、liquid 由 Phase 2+ 处理）。
 * @param gx gy 建筑左上角格坐标（Position / CELL_SIZE）
 */
export function inputPortCells(
  gx: number,
  gy: number,
  def: BuildingDefinition,
  direction: Direction,
): PortCell[] {
  const cells: PortCell[] = [];
  for (const port of def.ports) {
    if (port.type !== 'input') continue;
    const o = rotatePort(port, def.footprint, direction);
    cells.push({ port, x: gx + o.dx, y: gy + o.dy });
  }
  return cells;
}

/**
 * 建传送带格索引（"gx,gy" → 段实体）。MachineSystem 每 Tick 构建一次，
 * 供各设备端口 O(1) 查相邻供给带（传送带位置静态，Tick 内不变）。
 */
export function buildBeltCellIndex(world: World): Map<string, EntityHandle> {
  const map = new Map<string, EntityHandle>();
  for (const h of world.query('BeltSegmentComp', 'Position')) {
    const p = world.getComponent<Position>(h, 'Position');
    if (!p) continue;
    map.set(`${Math.round(p.x / CELL_SIZE)},${Math.round(p.y / CELL_SIZE)}`, h);
  }
  return map;
}

/**
 * 找指向端口格的供给传送带段 (A9 §6.7)。
 * 对 4 个方向 k 检查端口格 - dv(k) 处是否有 direction === k 的段——
 * 该段的出口相邻格（段格 + dv(k)）恰为端口格，即"方向指向设备"。
 * @returns 供给段 handle；无则 null。
 */
export function findFeederBelt(
  world: World,
  beltAt: Map<string, EntityHandle>,
  portCell: { x: number; y: number },
): EntityHandle | null {
  const dirs: readonly Direction[] = [0, 90, 180, 270];
  for (const k of dirs) {
    const dv = directionVector(k);
    const h = beltAt.get(`${portCell.x - dv.x},${portCell.y - dv.y}`);
    if (h === undefined) continue;
    const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp');
    if (seg && seg.direction === k) return h;
  }
  return null;
}

/**
 * 尝试吸入段上队首物品（progress ≥ PORT_ENTER_PROGRESS）到设备输入槽。
 * 队首 = progress 最大者（BeltSystem 每 tick 降序处理后的最靠出口物品）。
 * @returns 吸入的 itemId；null = 段上无物品 / 队首未到门口 / 输入槽不接受（物品留在传送带上）。
 */
export function tryAbsorbHeadItem(
  seg: BeltSegmentComp,
  comp: BuildingComp,
  capacity: number,
): string | null {
  const items = seg.items;
  if (!items || items.length === 0) return null;
  let head = items[0];
  for (const it of items) {
    if (it.progress > head.progress) head = it;
  }
  if (head.progress < PORT_ENTER_PROGRESS) return null;
  if (!tryAcceptItem(comp.bufferInput, head.itemId, capacity)) return null;
  items.splice(items.indexOf(head), 1);
  return head.itemId;
}
