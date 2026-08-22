// 端口状态判定 — 传送带连接 + 物流堵塞的只读计算 (T2.8 端口连接高亮)
// 依据: implementation-phase-2.md T2.8 需求3、A9 logistics-spec.md §6.7(端口连接判定)、
//       §3.4(堵塞)、T2.6 满槽堵停 / T2.7 满带留槽
//
// 纯逻辑模块 (DD-011，IntakeOps/OutputOps 先例): 只读计算"每个端口当前接没接传送带、
// 是否物流堵塞"，不写任何仿真状态。消费方两处，共享同一份判定避免视觉与调试钩子口径漂移:
//   - PortHighlightRenderer (渲染层): 端口格半透明着色（连接黄 #FFEF00 / 堵塞红）
//   - __game.portStatus() (调试钩子): 浏览器验收断言端口逻辑状态
//
// 语义 (T2.8 需求3，视觉母本 3x3_unit.svg 的 ports_top 组):
//   connected = A9 §6.7 连接判定成立——输入端口有指向它的供给带（findFeederBelt），
//               输出端口有入口朝向它的接收带（findReceiverBelt）。未连接不显示高亮。
//   blocked   = 已连接且连接该端口的传送带段堵塞（seg.blocked，BeltSystem 整链逆流传播，
//               与传送带带身/箭头同源）: 输入=供给带堵、输出=接收带堵。
//   paused   = 玩家手动暂停时物流视同离线（T2.8 需求2），门口停着的物品是暂停所致
//               而非真堵 → 不显示红（连接黄保留，物理连接关系不变；全局暂停由 LOGO 指示）。

import type { World, EntityHandle } from '../../ECS.ts';
import type { Position } from '../../components/Position.ts';
import type { BeltSegmentComp } from '../../components/BeltSegmentComp.ts';
import type { BuildingComp } from '../../components/BuildingComp.ts';
import type { BuildingDefinition } from '../../data/buildings.ts';
import { CELL_SIZE } from '../../render/constants.ts';
import {
  buildBeltCellIndex,
  inputPortCells,
  findFeederBelt,
} from './IntakeOps.ts';
import { outputPortCells, findReceiverBelt } from './OutputOps.ts';

/** 单个端口的高亮状态（渲染着色与调试钩子共用）。 */
export interface PortStatus {
  /** 端口定义（ports 数组内的原始引用）。 */
  port: BuildingDefinition['ports'][number];
  /** 端口世界格（Grid 坐标，已按设备朝向旋转）。 */
  x: number;
  y: number;
  /** 是否连接了传送带（A9 §6.7）。未连接 → 不显示高亮。 */
  connected: boolean;
  /** 已连接且物流堵塞（输入堵=物品停门口 / 输出堵=满带留槽）。 */
  blocked: boolean;
}

/** 设备左上角格坐标（Position / CELL_SIZE）。 */
function topLeftGrid(world: World, handle: EntityHandle): { gx: number; gy: number } | null {
  const pos = world.getComponent<Position>(handle, 'Position');
  if (!pos) return null;
  return { gx: Math.round(pos.x / CELL_SIZE), gy: Math.round(pos.y / CELL_SIZE) };
}

/**
 * 计算设备全部**输入**端口的连接/堵塞状态（按端口定义序）。
 * @param beltAt 传送带格索引（调用方构建或复用 buildBeltCellIndex）。
 * @param comp 设备组件（读 paused / direction）。
 */
export function inputPortStatuses(
  world: World,
  beltAt: Map<string, EntityHandle>,
  handle: EntityHandle,
  comp: BuildingComp,
  def: BuildingDefinition,
): PortStatus[] {
  const tl = topLeftGrid(world, handle);
  if (!tl) return [];
  const out: PortStatus[] = [];
  for (const cell of inputPortCells(tl.gx, tl.gy, def, comp.direction)) {
    const feeder = findFeederBelt(world, beltAt, cell);
    if (feeder === null) {
      out.push({ port: cell.port, x: cell.x, y: cell.y, connected: false, blocked: false });
      continue;
    }
    const seg = world.getComponent<BeltSegmentComp>(feeder, 'BeltSegmentComp');
    // paused: 物流视同离线，门口停车不算堵（暂停由 LOGO 指示，连接黄保留）。
    // 堵塞与传送带整链堵塞(seg.blocked)同源同步：队首停稳 → 整链红 → 端口红。
    const blocked = !comp.paused && seg !== undefined && seg.blocked === true;
    out.push({ port: cell.port, x: cell.x, y: cell.y, connected: true, blocked });
  }
  return out;
}

/**
 * 计算设备全部**输出**端口的连接/堵塞状态（按端口定义序）。
 * 输出堵 = 接收带堵塞（seg.blocked，整链逆流传播，与输出槽是否有货无关）；paused 时不红。
 */
export function outputPortStatuses(
  world: World,
  beltAt: Map<string, EntityHandle>,
  handle: EntityHandle,
  comp: BuildingComp,
  def: BuildingDefinition,
): PortStatus[] {
  const tl = topLeftGrid(world, handle);
  if (!tl) return [];
  const out: PortStatus[] = [];
  for (const cell of outputPortCells(tl.gx, tl.gy, def, comp.direction)) {
    const receiver = findReceiverBelt(world, beltAt, cell);
    if (receiver === null) {
      out.push({ port: cell.port, x: cell.x, y: cell.y, connected: false, blocked: false });
      continue;
    }
    const seg = world.getComponent<BeltSegmentComp>(receiver, 'BeltSegmentComp');
    // 堵塞与接收带整链堵塞(seg.blocked)同源同步：接收带堵 → 端口红（与输出槽是否有货无关）。
    const blocked = !comp.paused && seg !== undefined && seg.blocked === true;
    out.push({ port: cell.port, x: cell.x, y: cell.y, connected: true, blocked });
  }
  return out;
}

/** 便捷组合: 一台设备的全部端口状态（输入在前、输出在后，调试钩子 __game.portStatus 用）。 */
export function portStatuses(
  world: World,
  handle: EntityHandle,
  comp: BuildingComp,
  def: BuildingDefinition,
): { input: PortStatus[]; output: PortStatus[] } {
  const beltAt = buildBeltCellIndex(world);
  return {
    input: inputPortStatuses(world, beltAt, handle, comp, def),
    output: outputPortStatuses(world, beltAt, handle, comp, def),
  };
}
