// 传送带系统 — T2.1 单段移动 + T2.2 跨段传输与堵塞逆流
// 依据: implementation-phase-2.md T2.1/T2.2、A9 logistics-spec.md §2/§3、A5 simulation-spec.md §5
//
// 职责:
//   - 每 Simulation Tick 推进每段传送带上物品的 progress（+0.025/tick，0.5 格/秒）。
//   - 同段多物品最小间距夹紧（A9 §2.3，MIN_ITEM_GAP=0.25）。
//   - 跨段传输 (A9 §2.2/§3, T2.2): 队首 progress≥1.0 → 出口方向相邻 Cell 有下游段且入口有空位
//     → 物品移到下游段 progress=0（重新走）；无下游/下游满 → 钳制段尾 0.99 等待。
//   - 堵塞逆流 (A9 §3.4, T2.2): 下游满 → 本段队首停段尾 → 后方被间距夹住 → 本段塞满 →
//     更上游跨段失败 → 逆流向源头传播。下游疏通（入口腾位）→ hasSpace 恢复 → 上游恢复流动。
//
// 不在本系统（留给后续）:
//   - 端口吸入设备输入槽（T2.6 已实现，由 MachineSystem/machine/IntakeOps 处理:
//     物品在本系统钳制到 STOP_MAX=0.5 停在门口，MachineSystem 同 Tick 吸入输入槽）
//   - 设备输出物品注入传送带（T2.7 已实现，由 MachineSystem/machine/OutputOps 处理:
//     输出槽物品在 beltPhase 相位注入段首 items[]，本系统下一 Tick 起正常推进）
//
// 执行顺序 (A5 §5/DD-010): BeltSystem 先于 MachineSystem，保证物品先到达。
//   dt 恒为 50ms，progress 增量用固定常量 ITEM_PROGRESS_PER_TICK。

import type { World, EntityHandle } from '../ECS.ts';
import type { SimulationSystem } from '../GameLoop.ts';
import type { BeltItem, BeltSegmentComp } from '../components/BeltSegmentComp.ts';
import type { Position } from '../components/Position.ts';
import { directionVector } from './belt/BeltPathGeometry.ts';
import { CELL_SIZE } from '../render/constants.ts';

/**
 * 物品 progress 每 Tick 增量 (A9 §2.2)。
 * 推导: 传送带速度 0.5 格/秒 (A9 §1.2)，progress 归一化到 1 格，
 *   每 Tick(50ms=0.05s) 推进 0.5 × 0.05 = 0.025。跨一整段需 40 Tick / 2 秒。
 */
const ITEM_PROGRESS_PER_TICK = 0.025;

/**
 * 同段相邻物品的最小 progress 间距 (A9 §2.3，1/4 格)。同时用作跨段入口空位判定。
 *
 * 导出供 machine/OutputOps 复用（T2.7 设备输出注入的空位判定）：注入点与入口最近
 * 物品的间距标准必须与跨段传输一致，否则设备输出与跨段争抢入口时判定口径不一。
 */
export const MIN_ITEM_GAP = 0.25;

/**
 * 断头/堵塞时物品停止的 progress（格中心 0.5）。
 * 物品停在格中心，完全在格内、视觉居中（符合"走到尽头停下"的直观预期）。
 * 跨段时 progress 仍到 1.0（物品半在本格半在下格，边缘世界坐标连续），保证多格链流动视觉无缝。
 *
 * 导出供 machine/IntakeOps 复用（T2.6 端口吸入触发点）：物品"停在设备门口"与
 * "触发吸入判定"必须是同一 progress，否则槽满时停的位置与疏通后吸入的位置不一致。
 */
export const STOP_MAX = 0.5;

/**
 * 传送带系统。处理所有带 BeltSegmentComp 实体的物品移动、跨段传输与堵塞。
 */
export class BeltSystem implements SimulationSystem {
  /**
   * 全局传送带流动相位（0~1，全段共享）。每 tick 推进 ITEM_PROGRESS_PER_TICK，到 1.0 重置 0。
   * pointer 和物品共用此相位作为渲染时间源，消除两者（logical tick vs 渲染 elapsedMS）不同源
   * 导致的相位漂移与跨段闪烁。物品注入时 progress 对齐 beltPhase、跨段时（progress 1.0）beltPhase
   * 同步重置 0 → 物品在任何格内的位置都等于 pointer 位置（"物品=实体 pointer"，间距/节奏完全一致）。
   */
  static beltPhase = 0;
  /** 本 tick 的 beltPhase 增量，渲染层帧间插值用（正常=0.025，重置 tick=0 避免倒退跳跃）。 */
  static beltPhaseDelta = ITEM_PROGRESS_PER_TICK;

  update(world: World, _dt: number): void {
    // 反向遍历（链尾→链头）：跨段物品 push 到下游段时，下游已处理 → 本 tick 不推进新物品，
    // progress 保持 0，renderProgress 跨段边界连续（消除顿）。query 顺序=段创建顺序=链头→链尾，
    // 反向即物流逆序（下游先），堵塞时上游看到下游最新状态，更正确。
    const entities = world.query('BeltSegmentComp', 'Position');
    for (let i = entities.length - 1; i >= 0; i--) {
      const handle = entities[i];
      const seg = world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp');
      const pos = world.getComponent<Position>(handle, 'Position');
      if (!seg || !pos) continue;
      const items = seg.items;
      // 防御: 旧实体可能未初始化 items
      if (!items || items.length === 0) continue;
      this.processSegment(world, handle, seg, pos, items);
    }
    // 推进全局流动相位（pointer/物品同源同步用）。放物品移动之后，使 pointer 与物品同 tick 推进。
    // delta 始终=流动量（含重置 tick）。旧版重置时 delta=0 会导致 globalPhase 整 tick 固定 → pointer/物品顿一下。
    // 重置 tick beltPhase=0、delta=0.025 → globalPhase=0→0.025 平滑递增，无停滞。
    const np = BeltSystem.beltPhase + ITEM_PROGRESS_PER_TICK;
    BeltSystem.beltPhase = np >= 1.0 ? np - 1.0 : np;
    BeltSystem.beltPhaseDelta = ITEM_PROGRESS_PER_TICK;
  }

  /**
   * 推进一段传送带的物品：队首跨段/段尾停止 + 后方间距夹紧。
   *
   * 物品按 progress 降序处理（队首=progress 最大=最靠近出口）。队首先确定去向
   * （跨段离开 / 停段尾 / 正常前进），后方物品相对前方做间距夹紧 (A9 §2.3)。
   * 物品永不后退（防御异常重叠注入）。
   */
  private processSegment(
    world: World,
    handle: EntityHandle,
    seg: BeltSegmentComp,
    pos: Position,
    items: BeltItem[],
  ): void {
    // 按 progress 降序（队首在前），不改原数组顺序
    const ordered = items.slice().sort((a, b) => b.progress - a.progress);

    // === 队首：跨段 / 段尾停止 / 正常前进 ===
    const head = ordered[0];
    const oldHead = head.progress;
    const headAdvanced = oldHead + ITEM_PROGRESS_PER_TICK;
    /** 后方物品的限制基准（前方物品的 progress）；队首跨段离开后用 1.0=段尾边界(=下游段首)。 */
    let leaderProgress: number;

    // 下游是否可跨段（本 tick 判定，堵塞时动态变化）
    const downstream = this.findDownstream(world, handle, pos, seg);
    const canTransfer = downstream !== null && this.hasSpaceAtEntry(world, downstream);

    if (canTransfer && headAdvanced >= 1.0) {
      // 跨段: 队首离开本段，进入下游段首 progress=0（A9 §2 "重新走"）。
      // 段尾边界与下游段首边界在世界坐标重合 → 视觉无跳跃。
      const downSeg = world.getComponent<BeltSegmentComp>(downstream, 'BeltSegmentComp');
      if (downSeg) {
        const downItems = downSeg.items ?? (downSeg.items = []);
        downItems.push({ itemId: head.itemId, progress: 0, delta: ITEM_PROGRESS_PER_TICK }); // delta=流动量，渲染插值连续（避免跨段顿）
        // 从本段 items 移除 head（按引用）
        const idx = items.indexOf(head);
        if (idx >= 0) items.splice(idx, 1);
      }
      // 队首已离开本段；次首的前方现在是"下游段首"(世界=本段 progress 1.0 边界)
      leaderProgress = 1.0; // 后方相对段尾(=下游首)保持间距
    } else if (!canTransfer) {
      // 无下游 / 下游入口满 → 停在段尾不凸出位置（A9 §3.1-B / §3.4 堵塞）。
      // 钳到 STOP_MAX：物品完全在格内（出口边缘=格边缘，不凸出）。
      const stopAt = Math.min(headAdvanced, STOP_MAX);
      head.progress = stopAt;
      head.delta = Math.max(0, stopAt - oldHead); // 停稳后 delta=0（渲染静止，不插值）
      leaderProgress = stopAt;
    } else {
      // 能跨段但未到段尾：正常前进
      head.progress = headAdvanced;
      head.delta = ITEM_PROGRESS_PER_TICK;
      leaderProgress = headAdvanced;
    }

    // === 后方物品：间距夹紧（相对前方 leaderProgress）===
    for (let i = 1; i < ordered.length; i++) {
      const item = ordered[i];
      const old = item.progress;
      let next = old + ITEM_PROGRESS_PER_TICK;
      const limit = leaderProgress - MIN_ITEM_GAP;
      if (next > limit) next = limit;
      if (next < old) next = old; // 不后退（被前方夹住时保持不动）
      item.progress = next;
      item.delta = next - old; // 被夹住不动时 delta=0（渲染静止，不插值）
      leaderProgress = next;
    }
  }

  /**
   * 找出口方向相邻 Cell 的下游传送带段 (A9 §4.2 隐式连接)。
   * seg.direction 是出口方向（直段=流向，转角段=出口方向，见 BeltSegmentComp）。
   * @returns 下游段 handle；无则 null（断头）。
   */
  private findDownstream(
    world: World,
    self: EntityHandle,
    pos: Position,
    seg: BeltSegmentComp,
  ): EntityHandle | null {
    const dv = directionVector(seg.direction);
    const neighborX = pos.x + dv.x * CELL_SIZE;
    const neighborY = pos.y + dv.y * CELL_SIZE;
    const candidates = world.query('BeltSegmentComp', 'Position');
    for (const h of candidates) {
      if (h === self) continue;
      const p = world.getComponent<Position>(h, 'Position');
      if (p && Math.abs(p.x - neighborX) < 1 && Math.abs(p.y - neighborY) < 1) {
        return h;
      }
    }
    return null;
  }

  /**
   * 下游段入口（progress=0 侧）是否有空间接收新物品 (A9 §2.4 跨段间距)。
   * 新物品进 progress=0，需与下游最靠近入口的物品（progress 最小）保持 ≥ MIN_ITEM_GAP。
   * @returns true=可接收（空段 或 入口最近物品 progress ≥ GAP）。
   */
  private hasSpaceAtEntry(world: World, downHandle: EntityHandle): boolean {
    const down = world.getComponent<BeltSegmentComp>(downHandle, 'BeltSegmentComp');
    if (!down) return true;
    const items = down.items;
    if (!items || items.length === 0) return true;
    let minProgress = Infinity;
    for (const it of items) {
      if (it.progress < minProgress) minProgress = it.progress;
    }
    return minProgress >= MIN_ITEM_GAP;
  }
}
