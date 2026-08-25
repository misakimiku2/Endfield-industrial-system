// 输入对接操作 — 传送带 → 设备输入端口吸入 (T2.6，2026-08-17 修订为"预约制端口格中心吸入")
// 依据: implementation-phase-2.md T2.6、精炼炉设备说明.md（吸入点确认）、
//       A9 logistics-spec.md §3.3(端口吸入)/§3.6(吸入副作用)/§6.7(端口连接判定)、
//       A8 production-system-spec.md §7 步骤2(输入物流)
//
// 纯逻辑模块 (DD-011，BufferOps/ProductionOps 先例): 判定"哪条传送带在喂哪个输入端口"
// 与"预约/放行一件物品进入设备"，由 MachineSystem 每 Tick 对每台设备的每个输入端口调用。
//
// 连接判定 (A9 §6.7): 传送带段的末端格与设备某 Input Port 的 Cell 相邻，
//   且传送带方向"指向"设备（段格 + directionVector(direction) === 端口格）。
//
// 预约制（两阶段，用户 2026-08-17 拍板"物品要走到端口格中心才算进入设备"）:
//   阶段1 预约 tryAbsorbHeadItem: 队首物品 progress ≥ STOP_MAX(0.5 供给格中心) 时判定——
//     tryAcceptItem 通过（空槽或锁定同类型未满，count 即 +1 槽位当场占用）→ entering=true，
//     物品**不移除**，由 BeltSystem 放行推进 0.5 → PORT_ENTER_DONE(1.5 端口格中心)。
//     槽满/类型不符 → 物品停在 0.5（BeltSystem 钳制，与精炼炉说明"堵塞停留在 0,3 这一格"
//     一致，STOP_MAX 语义不变）；槽腾出后停在门口的物品立即被预约（堵塞→疏通，A9 §3.5）。
//     预约制防多端口争抢: 槽在门口判定瞬间即占用，与"预约物品后续 1 格行程"解耦。
//   阶段2 放行 releaseArrivedItems: entering 物品 progress ≥ PORT_ENTER_DONE(1.5) →
//     从段 items[] 移除（视觉消失在端口格中心，走进设备半格深处），完成进入。
//
// 吸入副作用 (A9 §3.6 三件套): 槽 count+1 + 空槽锁定类型由阶段1 tryAcceptItem 完成
//   （BufferOps，A8 §2.1 输入槽规则），items[] 移除由阶段2完成——拆成两 Tick 相位
//   只是视觉行程（物品从门口走进设备内部），槽位语义在预约瞬间已一致。
// 节流 (A8 §4.1): 每个输入端口每走访至多预约 1 件（只看队首）。多端口轮询指针
//   (inputPollIndex) 已由 T2.10 实现于 MachineSystem.absorbBeltInputs——本模块只提供
//   单口预约/放行原语，走访顺序（从指针起循环、满载冻结）由调用方决定。

import type { World, EntityHandle } from '../../ECS.ts';
import type { Position } from '../../components/Position.ts';
import type { BeltSegmentComp } from '../../components/BeltSegmentComp.ts';
import type { BuildingComp, Direction } from '../../components/BuildingComp.ts';
import type { BuildingDefinition } from '../../data/buildings.ts';
import { STOP_MAX, PORT_ENTER_DONE } from '../BeltSystem.ts';
import { directionVector } from '../belt/BeltPathGeometry.ts';
import { rotatePort } from '../PortGeometry.ts';
import { tryAcceptItem } from './BufferOps.ts';
import { CELL_SIZE } from '../../render/constants.ts';

/** 预约判定的队首 progress（= BeltSystem.STOP_MAX 供给格中心，A9 §3.3，两值必须同源）。 */
export const PORT_ENTER_PROGRESS = STOP_MAX;
/** 预约物品的放行/移除点（= BeltSystem.PORT_ENTER_DONE 端口格中心 1.5，两值必须同源）。 */
export const PORT_RELEASE_PROGRESS = PORT_ENTER_DONE;

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
 * 放行已到达端口格中心的预约物品（阶段2）。
 * 移除段上所有 entering 且 progress ≥ PORT_RELEASE_PROGRESS(1.5) 的物品
 * （一格一物品下至多 1 件），完成"物品消失在设备输入端口格中心"。
 * @returns 被移除的 itemId 列表（一般空或 1 件；MachineSystem 不为其发事件——
 *          预约时刻已发 input 事件，槽 count 早在预约时 +1）。
 */
export function releaseArrivedItems(seg: BeltSegmentComp): string[] {
  const items = seg.items;
  if (!items || items.length === 0) return [];
  const released: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.entering && it.progress >= PORT_RELEASE_PROGRESS) {
      released.push(it.itemId);
      items.splice(i, 1);
    }
  }
  return released;
}

/**
 * 尝试预约段上队首物品进入设备（阶段1）。
 * 队首 = 非 entering 物品中 progress 最大者（entering 物品已属设备，正在走进端口格）。
 * 队首 progress ≥ PORT_ENTER_PROGRESS(0.5 供给格中心) 时 tryAcceptItem 判定——
 * 通过则槽 count+1（当场占用）并标记 entering=true（物品不移除，BeltSystem 放行
 * 推进到 1.5 端口格中心，随后由 releaseArrivedItems 移除）。
 * @returns 预约的 itemId；null = 段上无可预约物品 / 队首未到门口 / 输入槽不接受（物品停在传送带上）。
 */
export function tryAbsorbHeadItem(
  seg: BeltSegmentComp,
  comp: BuildingComp,
  capacity: number,
): string | null {
  const items = seg.items;
  if (!items || items.length === 0) return null;
  let head = null as (typeof items)[number] | null;
  for (const it of items) {
    if (it.entering) continue;
    if (head === null || it.progress > head.progress) head = it;
  }
  if (head === null || head.progress < PORT_ENTER_PROGRESS) return null;
  if (!tryAcceptItem(comp.bufferInput, head.itemId, capacity)) return null;
  head.entering = true;
  return head.itemId;
}
