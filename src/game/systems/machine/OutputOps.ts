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
// 注入相位（2026-08-25 退役"物品=实体 pointer"约定，用户实测: 不同时间创建的
//   传送带物品/指针全局锁步不符实际玩法）: 旧版注入在全局 beltPhase 相位且仅
//   ≤STOP_MAX 窗口注入；改为**段首 progress=0** 注入——物品进度独立推进，断头
//   钳制 0→0.5 只进不退无后跳，相位窗口退役；指针动画按链独立相位（渲染层）。
// 满带判定 (一格一物品): 只往**空段**注入——段上已有物品即满，物品留在输出槽，
//   每 Tick 重试（带腾位即恢复，对称 T2.6 疏通）。吞吐 1 件/格 × 0.5 格/秒 = 每 2 秒 1 件。
// 节流 (A8 §4.2): 每个输出端口每 Tick 至多放出 1 件。多端口轮询（活跃队列轮转/
//   堵塞移出/恢复追加队尾）已由 T2.10 实现于 MachineSystem.emitBeltOutputs——本模块
//   只提供单口注入原语 tryEmitToBelt 与连接判定。

import type { World, EntityHandle } from '../../ECS.ts';
import type { BeltSegmentComp } from '../../components/BeltSegmentComp.ts';
import type { BuildingComp, Direction } from '../../components/BuildingComp.ts';
import type { BuildingDefinition } from '../../data/buildings.ts';
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
 * 取第一个非空输出槽（一槽一物，A8 §2.2），注入段 items[] **段首 progress=0**
 * （紧邻设备的入口边界，视觉"从机器里出来"），扣减输出槽 count（到 0 解锁）。
 *
 * 注入相位沿革（2026-08-25 退役"物品=实体 pointer"约定）: 旧版注入在全局
 * beltPhase 相位且仅 ≤STOP_MAX 窗口注入——物品与指针动画全局锁步，不同时间
 * 创建的传送带看起来同步流动（用户实测指出不符实际玩法）。改为段首注入后
 * 物品进度独立推进（断头钳制 0→0.5 只进不退，无视觉后跳，相位窗口不再需要），
 * 指针动画改为按链独立相位（BeltPointerRenderer）。
 * @returns 放出的 itemId；null = 输出槽空 / 段上已有物品（一格一物品 → 满带，
 *          物品留在输出槽，下 Tick 重试）。
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

  // 2. 一格一物品: 只往空段注入（段上已有物品 → 满带，物品留在输出槽）
  const items = seg.items ?? (seg.items = []);
  if (items.length > 0) return null;

  // 3. 注入段首 progress=0（delta=0: 出现即静止，下一 Tick 起 BeltSystem 推进并插值）
  items.push({ itemId, progress: 0, delta: 0 });
  consumeFromSlot(slot, 1);
  return itemId;
}
