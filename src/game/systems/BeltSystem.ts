// 传送带系统 — T2.1 单段移动 + T2.2 跨段传输与堵塞逆流
// 依据: implementation-phase-2.md T2.1/T2.2、A9 logistics-spec.md §2/§3、A5 simulation-spec.md §5
//
// 职责:
//   - 每 Simulation Tick 推进每段传送带上物品的 progress（+0.025/tick，0.5 格/秒）。
//   - 一格一物品（用户 2026-08-17 澄清，修订 A9 §2.3 的 0.25 间距）:
//     一格传送带只承载一个物品（"箭头"或"物品"二选一）。同段 items[] 实际至多 1 件
//     （多件仅调试注入可致，跟随夹紧按 MIN_ITEM_GAP=1.0 冻结后方）。
//   - 跨段传输 (A9 §2.2/§3, T2.2): 队首 progress≥1.0 且**下游段为空** → 进入下游段首
//     progress=0（重新走）；下游占用 → 本段队首推进不得越过下游最近物品的 progress
//     （世界间距 ≥ 1 格，反向遍历读到下游本 Tick 最新位置 → 整链 lockstep 流动）。
//   - 堵塞逆流 (A9 §3.4, T2.2): 下游占用 → 本段队首停在下游最近物品的 progress（≤0.5）
//     → 本段视为满 → 上游跨段失败 → 逆流向源头传播。下游疏通（腾空）→ 上游恢复流动。
//
// 不在本系统（留给后续）:
//   - 端口吸入设备输入槽（T2.6 已实现，由 MachineSystem/machine/IntakeOps 处理）:
//     物品在供给格中心 0.5 被预约（IntakeOps.tryAbsorbHeadItem: 槽 count+1 + entering=true），
//     本系统放行 entering 物品推进到 PORT_ENTER_DONE=1.5（端口格中心），MachineSystem
//     同 Tick releaseArrivedItems 移除（视觉消失走进设备半格深处）。未预约物品钳 0.5 停在门口。
//   - 设备输出物品注入传送带（T2.7 已实现，由 MachineSystem/machine/OutputOps 处理:
//     输出槽物品在 beltPhase 相位注入**空段**首，本系统下一 Tick 起正常推进）
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
 * 相邻物品的最小世界间距（格）。一格一物品（用户 2026-08-17 澄清，修订 A9 §2.3 的
 * 0.25）→ 间距 = 1 格: 同段内两件物品 progress 差 ≥ 1.0（即同段实际至多 1 件），
 * 跨段跟随由队首推进钳制保证（不得越过下游段最近物品的 progress）。
 * 吞吐换算: 1 件/格 × 0.5 格/秒 = 每 2 秒 1 件，与全部已定义配方节拍一致。
 */
export const MIN_ITEM_GAP = 1.0;

/**
 * 断头/堵塞时物品停止的 progress（格中心 0.5）。
 * 物品停在格中心，完全在格内、视觉居中（符合"走到尽头停下"的直观预期）。
 * 跨段时 progress 仍到 1.0（物品半在本格半在下格，边缘世界坐标连续），保证多格链流动视觉无缝。
 *
 * 导出供 machine/IntakeOps 复用（T2.6 端口吸入触发点）：物品"停在设备门口"与
 * "触发吸入判定"必须是同一 progress，否则槽满时停的位置与疏通后吸入的位置不一致。
 * 也供 machine/OutputOps 复用（T2.7 注入相位窗口上限）。
 */
export const STOP_MAX = 0.5;

/**
 * 预约进入设备的物品的推进上限（端口格中心 1.5 = STOP_MAX + 1 格，2026-08-17 用户拍板）。
 * 物品在供给格中心 0.5 做判定（IntakeOps.tryAbsorbHeadItem 预约: 槽 count+1 + entering=true），
 * 预约后本系统放行其推进 0.5 → 1.5（走进设备半格深处），到达 1.5 由 MachineSystem
 * 调 releaseArrivedItems 从 items[] 移除（视觉消失在端口格中心）。
 * 未预约物品仍钳 STOP_MAX（堵塞停在供给格中心，与精炼炉说明"堵塞停留在 0,3 这一格"一致）。
 *
 * 定义在本文件与 STOP_MAX 同源（1.5 恒等于 0.5+1 格）；IntakeOps 导入复用
 * （反向导入会造成 BeltSystem ↔ IntakeOps 循环依赖）。
 */
export const PORT_ENTER_DONE = STOP_MAX + 1.0;

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
   * 推进一段传送带的物品：队首跨段/间距钳制/段尾停止 + 后方夹紧。
   *
   * 物品按 progress 降序处理（队首=progress 最大=最靠近出口）。一格一物品模型下
   * 队首的推进规则:
   *   - 无下游段（断头/设备门口）→ 钳制 STOP_MAX=0.5 格中心（T2.6 吸入触发点同源）。
   *   - 下游段空 → 自由前进，progress ≥ 1.0 时跨段进入下游段首 progress=0。
   *   - 下游段占用 → 推进不得越过下游最近物品的 progress（世界间距 ≥ 1 格；
   *     反向遍历保证读到的是下游本 Tick 已推进的位置 → 流动时整链 lockstep，
   *     堵塞时队首停在下游物品位置后方，随堵塞解除逐格跟进）。
   * 后方物品相对前方做同段夹紧（MIN_ITEM_GAP=1.0 → 正常情况同段仅队首 1 件，
   * 多件仅调试注入可致，后方冻结不前进）。物品永不后退（防御异常重叠注入）。
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

    // === 队首：跨段 / 间距钳制 / 段尾停止 ===
    const head = ordered[0];
    const oldHead = head.progress;
    const headAdvanced = oldHead + ITEM_PROGRESS_PER_TICK;
    /** 后方物品的限制基准（前方物品的 progress）；队首跨段离开后用 1.0=段尾边界(=下游段首)。 */
    let leaderProgress: number;

    const downstream = this.findDownstream(world, handle, pos, seg);
    // 下游段最近入口物品的 progress（空段 = Infinity = 可自由前进/跨段）
    let downMin = Infinity;
    let downSeg: BeltSegmentComp | null | undefined = null;
    if (downstream !== null) {
      downSeg = world.getComponent<BeltSegmentComp>(downstream, 'BeltSegmentComp');
      const downItems = downSeg?.items;
      if (downItems && downItems.length > 0) {
        for (const it of downItems) {
          if (it.progress < downMin) downMin = it.progress;
        }
      }
    }

    if (head.entering) {
      // 已预约进入设备（IntakeOps 在供给格中心 0.5 判定 tryAcceptItem 成功 + entering=true）:
      // 放行推进 0.5 → PORT_ENTER_DONE=1.5（端口格中心，走进设备半格深处），不参与跨段/间距钳制
      // （预约物品已属设备，即使下游拓扑中途变化——如玩家在门口插带——也必定走完进设备）。
      // 到达 1.5 由 MachineSystem.releaseArrivedItems 从 items[] 移除（视觉消失）。
      const stopAt = Math.min(headAdvanced, PORT_ENTER_DONE);
      head.progress = stopAt;
      head.delta = Math.max(0, stopAt - oldHead);
      leaderProgress = stopAt;
    } else if (downstream === null) {
      // 断头（无下游带）: 停在格中心不凸出位置（A9 §3.1-B / §3.4 堵塞，T2.6 门口同点）。
      const stopAt = Math.min(headAdvanced, STOP_MAX);
      head.progress = stopAt;
      head.delta = Math.max(0, stopAt - oldHead); // 停稳后 delta=0（渲染静止，不插值）
      leaderProgress = stopAt;
    } else if (headAdvanced >= 1.0 && downMin === Infinity) {
      // 跨段: 下游空，队首离开本段进入下游段首 progress=0（A9 §2 "重新走"）。
      // 段尾边界与下游段首边界在世界坐标重合 → 视觉无跳跃。
      if (downSeg) {
        const downItems = downSeg.items ?? (downSeg.items = []);
        downItems.push({ itemId: head.itemId, progress: 0, delta: ITEM_PROGRESS_PER_TICK }); // delta=流动量，渲染插值连续（避免跨段顿）
        // 从本段 items 移除 head（按引用）
        const idx = items.indexOf(head);
        if (idx >= 0) items.splice(idx, 1);
      }
      // 队首已离开本段；次首的前方现在是"下游段首"(世界=本段 progress 1.0 边界)
      leaderProgress = 1.0; // 后方相对段尾(=下游首)保持间距
    } else {
      // 下游占用（或未到段尾）: 推进不得越过下游最近物品的 progress（一格一物品）。
      // 下游本 Tick 已处理（反向遍历）→ downMin 为最新值: 流动时队首正常 +0.025 前进
      // （下游物品同 Tick 也前进了），堵塞时停在下游物品位置后方。
      // cap 1.0: 下游 entering 物品（预约走进端口格）progress 可达 1.5 > 段尾——
      // 非 entering 物品仍不得越过本段段尾 1.0（>1.0 仅预约物品合法，其走 entering 分支）。
      const stopAt = Math.min(headAdvanced, Math.min(downMin, 1.0));
      head.progress = Math.max(oldHead, stopAt); // 不后退（防御异常重叠注入）
      head.delta = head.progress - oldHead; // 被夹住不动时 delta=0（渲染静止，不插值）
      leaderProgress = head.progress;
    }

    // === 后方物品：间距夹紧（相对前方 leaderProgress，仅调试注入的多件场景可达）===
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
}
