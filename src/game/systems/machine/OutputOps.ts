// 输出对接操作 — 设备输出端口 → 传送带注入 (T2.7)
// 依据: implementation-phase-2.md T2.7、A9 logistics-spec.md §6.7(端口连接判定)、
//       A8 production-system-spec.md §7 步骤3(输出物流)/§4.2(输出轮询)、
//       一格一物品规则（用户 2026-08-17 澄清，修订 A9 §2.3 间距）
//
// 纯逻辑模块 (DD-011，IntakeOps 先例): 判定"哪条传送带在接哪个输出端口的货"
// 与"从输出槽放出一件物品到传送带"，由 MachineSystem 每 Tick 对每台设备的每个
// 输出端口调用（A8 §7 顺序: 内部状态 → 输入物流 → 输出物流）。
//
// 连接判定 (A9 §6.7): 传送带段的 Cell 与设备某 Output Port 的 Cell 相邻，
//   且传送带方向"背离"设备——段的入口侧（段格 − 入口朝向向量）恰为端口格。
//   直段入口朝向 = direction；转角段 = entryDir（物品从 entryDir 侧进入转角）。
// 注入相位 (T2.1"物品=实体 pointer"约定，T2.6 修复定型): progress = BeltSystem.beltPhase，
//   物品出现在 pointer 当前位置、此后与 pointer 同速推进（间距/节奏与指针动画一致）。
//   且仅在 beltPhase ≤ STOP_MAX 时注入: 断头段的物品被 BeltSystem 钳制在 STOP_MAX(0.5)，
//   若在更高相位注入，下一 Tick 会被钳回 0.5（物品视觉后跳）。beltPhase 每 40 Tick
//   循环一次，≤0.5 的窗口每秒一次 → 空带吞吐 1 件/2 秒，恰与全部已定义配方节拍一致。
// 满带判定 (一格一物品): 只往**空段**注入——段上已有物品即满，物品留在输出槽，
//   每 Tick 重试（带腾位即恢复，对称 T2.6 疏通）。吞吐 1 件/格 × 0.5 格/秒 = 每 2 秒 1 件。
// 节流 (A8 §4.2): 每个输出端口每 Tick 至多放出 1 件。多端口轮询（活跃队列轮转/
//   堵塞移出/恢复追加队尾）已由 T2.10 实现于 MachineSystem.emitBeltOutputs——本模块
//   只提供单口注入原语 tryEmitToBelt 与连接判定。

import type { World, EntityHandle } from '../../ECS.ts';
import type { BeltSegmentComp } from '../../components/BeltSegmentComp.ts';
import type { BuildingComp, Direction } from '../../components/BuildingComp.ts';
import type { BuildingDefinition } from '../../data/buildings.ts';
import { STOP_MAX, BeltSystem } from '../BeltSystem.ts';
import { directionVector } from '../belt/BeltPathGeometry.ts';
import { rotatePort } from '../PortGeometry.ts';
import { consumeFromSlot } from './BufferOps.ts';
import type { PortCell } from './IntakeOps.ts';

/**
 * 计算设备全部**输出**端口的世界格（按定义顺序，即"左→中→右"连接序）。
 * 输入端口在 IntakeOps.inputPortCells（liquid 端口由 Phase 2+ 处理）。
 * @param gx gy 建筑左上角格坐标（Position / CELL_SIZE）
 */
export function outputPortCells(
  gx: number,
  gy: number,
  def: BuildingDefinition,
  direction: Direction,
): PortCell[] {
  const cells: PortCell[] = [];
  for (const port of def.ports) {
    if (port.type !== 'output') continue;
    const o = rotatePort(port, def.footprint, direction);
    cells.push({ port, x: gx + o.dx, y: gy + o.dy });
  }
  return cells;
}

/**
 * 找接收端口出货的传送带段 (A9 §6.7 "设备输出 → 传送带")。
 * 对 4 个方向 k 检查端口格 + dv(k) 处是否有段，且该段的**入口朝向**为 k——
 * 段格 − dv(入口朝向) = 端口格，即传送带从端口方向进料、流向背离设备。
 * 直段入口朝向 = direction；转角段 = entryDir（A9 §6.2 转角从入方向一侧进料）。
 * @returns 接收段 handle；无则 null。
 */
export function findReceiverBelt(
  world: World,
  beltAt: Map<string, EntityHandle>,
  portCell: { x: number; y: number },
): EntityHandle | null {
  const dirs: readonly Direction[] = [0, 90, 180, 270];
  for (const k of dirs) {
    const dv = directionVector(k);
    const h = beltAt.get(`${portCell.x + dv.x},${portCell.y + dv.y}`);
    if (h === undefined) continue;
    const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp');
    if (seg && (seg.entryDir ?? seg.direction) === k) return h;
  }
  return null;
}

/**
 * 尝试从输出槽放出一件物品到传送带段首。
 * 取第一个非空输出槽（一槽一物，A8 §2.2），在 beltPhase 相位注入段 items[]
 * （物品=实体 pointer），扣减输出槽 count（到 0 解锁）。
 * @returns 放出的 itemId；null = 输出槽空 / pointer 相位 > STOP_MAX（本 Tick 窗口外）/
 *          段上已有物品（一格一物品 → 满带，物品留在输出槽，下 Tick 重试）。
 */
export function tryEmitToBelt(
  seg: BeltSegmentComp,
  comp: BuildingComp,
): string | null {
  // 1. 第一个非空输出槽（全部为空 → 无货可出）
  let slot = null as (typeof comp.bufferOutput)[number] | null;
  for (const s of comp.bufferOutput) {
    if (s.itemId !== null && s.count > 0) { slot = s; break; }
  }
  if (slot === null || slot.itemId === null) return null;
  const itemId = slot.itemId; // consumeFromSlot 扣到 0 会置 null，先取

  // 2. 注入相位窗口: 仅 pointer 位于靠端口半格（≤ STOP_MAX）时注入
  const p = BeltSystem.beltPhase;
  if (p > STOP_MAX) return null;

  // 3. 一格一物品: 只往空段注入（段上已有物品 → 满带，物品留在输出槽）
  const items = seg.items ?? (seg.items = []);
  if (items.length > 0) return null;

  // 4. 注入（delta=0: 出现即静止，下一 Tick 起 BeltSystem 推进并插值）
  items.push({ itemId, progress: p, delta: 0 });
  consumeFromSlot(slot, 1);
  return itemId;
}
