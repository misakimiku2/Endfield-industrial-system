// 指针相位时钟 — 纯逻辑模块（T2.22/T2.22b，2026-09-05 指针闪烁修复终稿）
//
// v11（2026-08-27）指针相位跟随本链领头物品: phase = (leaderTotal − segIdx) mod 1，
// 链上无物品回退自由时钟。两处不连续（用户 2026-09-05 实测"指针闪烁位移"）:
//   ① 模式切换: 带清空瞬间相位从领头位置跳到哈希时钟、下一件注入又跳回 0——
//      T2.21 稀疏输出（1-0-1 分摊）让短带有周期性清空 → 周期性双跳变（S2 实测
//      每周期 领头消失/领头出现 各跳一次）。
//   ② 领头插值用 progress + alpha·delta（外推）: 领头停走的 Tick 边界相位回跳
//      ~0.025 格（BeltItemRenderer 2026-09-02 已改 prev→cur 内插修复物品侧同类
//      问题，指针公式的孪生缺陷遗留）。
//
// 本时钟每链维护连续相位载体 virt:
//   - 有领头: virt += 领头**内插**位置的帧增量（≤0 钳 0——吸收/换领头的整数回退
//     不打扰相位，mod 1 天然连续）; 领头移动时叠加 ≤10% 带速的微漂移，把注入/
//     非整格回退留下的常数相位偏移缓慢收敛回 v11 精确对齐（队列停走时不漂移）。
//   - 无领头（空带）: virt += 本帧带速增量——从领头离开的位置**无缝**继续流动。
//   - 领头刚出现（空带→有物）: virt 不动——箭头保持流动原位、队列汇入，不再跳变。
//   - 链首次观测: 播种 globalPhase + chainId 哈希（同旧自由时钟，无连续性可破）。
// 语义与 v11 完全一致: 队列停 → 箭头停（virt 只随领头实际位移前进）; 队列进 →
// 箭头随行; 空带继续流动; 唯一差异 = 注入瞬间箭头不跳变对齐，改为保持原位后
// 随流动缓慢对齐（用户 2026-08-25 起历轮否决的都是"跳变/闪动"，缓变不在其列）。
//
// 物品内插状态用 WeakMap（物品移除/跨段重建自动回收），跨段新物品以
// progress−delta 起步（跨段前格 1.0 == 新格 0，世界坐标连续——BeltItemRenderer
// 同款约定）。Tick 边界由 alpha 回卷检测（accumulator −= SIM_STEP → 变小）。

import type { EntityHandle } from '../ECS';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import type { BeltItem } from '../components/BeltSegmentComp';

/** 单链相位载体状态。 */
interface ChainFlow {
  /** 连续相位载体（未取模的领头等价位置; 箭头相位 = (virt − segIdx) mod 1）。 */
  virt: number;
  /** 上一帧领头的内插位置; null = 上一帧链上无物品。 */
  prevLeader: number | null;
}

/**
 * 指针相位时钟（纯逻辑，无 Pixi 依赖——node 诊断脚本可直接驱动验证）。
 * 每帧调用一次 computePhases，传入全部可见段与全局相位（beltPhase + alpha·delta）。
 */
export class PointerPhaseClock {
  private readonly chains = new Map<string, ChainFlow>();
  /** 物品 → Tick 边界推进的内插状态（BeltItemRenderer.renderState 同款）。 */
  private itemPos = new WeakMap<BeltItem, { prevTick: number; lastSeen: number }>();
  private lastAlpha = -1;
  private lastGlobalPhase: number | null = null;

  /** 清空全部链/物品内插状态（场景重置/诊断脚本隔离用）。 */
  reset(): void {
    this.chains.clear();
    this.itemPos = new WeakMap();
    this.lastAlpha = -1;
    this.lastGlobalPhase = null;
  }

  /**
   * 计算本帧每段箭头相位。
   * @param segs 全部可见段（handle + 组件）
   * @param globalPhase 全局相位（beltPhase + alpha·beltPhaseDelta，Tick 内单调、
   *        跨 Tick 以 1 为模回卷——帧间增量 = (cur−prev+1)%1 即本帧带速流动量）
   * @param alpha 仿真周期插值系数（Tick 边界回卷检测用）
   * @returns 段 handle → 箭头相位 [0,1)
   */
  computePhases(
    segs: ReadonlyArray<{ handle: EntityHandle; seg: BeltSegmentComp }>,
    globalPhase: number,
    alpha: number,
  ): Map<EntityHandle, number> {
    const tickBoundary = alpha < this.lastAlpha;
    this.lastAlpha = alpha;
    // 本帧带速流动量（帧率无关: 一 Tick 恰合计 0.025; 暂停时 ≈0）
    const frameFlow = this.lastGlobalPhase === null
      ? 0
      : ((globalPhase - this.lastGlobalPhase) % 1 + 1) % 1;
    this.lastGlobalPhase = globalPhase;

    // ① 每链领头的内插位置 = max(段序号 + 物品内插 progress)（含 entering 行走 >1）
    const leaderByChain = new Map<string, number>();
    for (const { seg } of segs) {
      const items = seg.items ?? [];
      if (items.length === 0) continue;
      const idx = seg.segmentIndex ?? 0;
      for (const it of items) {
        let st = this.itemPos.get(it);
        if (st === undefined) {
          st = { prevTick: it.progress - (it.delta || 0), lastSeen: it.progress };
          this.itemPos.set(it, st);
        } else if (tickBoundary) {
          st.prevTick = st.lastSeen;
          st.lastSeen = it.progress;
        }
        const total = idx + st.prevTick + alpha * (st.lastSeen - st.prevTick);
        const cur = leaderByChain.get(seg.chainId);
        if (cur === undefined || total > cur) leaderByChain.set(seg.chainId, total);
      }
    }

    // ② 推进与取相位必须分开（T2.22a 修订，用户实测"空带越长箭头越快"定位）:
    //    virt 是**全链共享**的相位载体——每链每帧只推进**一次**。旧版把推进写进
    //    按段循环里，N 段链每帧推进 N 次 = 箭头 N 倍速。先按出现序去重收集链、逐链推进，再按段派生相位。
    const out = new Map<EntityHandle, number>();
    const seenChains = new Set<string>();
    const chainOrder: string[] = [];
    for (const { seg } of segs) {
      if (!seenChains.has(seg.chainId)) {
        seenChains.add(seg.chainId);
        chainOrder.push(seg.chainId);
      }
    }
    for (const chainId of chainOrder) {
      let st = this.chains.get(chainId);
      if (st === undefined) {
        st = { virt: (globalPhase + chainPhaseOf(chainId)) % 1, prevLeader: null };
        this.chains.set(chainId, st);
      }
      const leader = leaderByChain.get(chainId);
      if (leader === undefined) {
        // 空带: 从领头离开的位置无缝续流（链首次观测时 virt=哈希种子，同为连续起点）
        st.virt += frameFlow;
        st.prevLeader = null;
      } else if (st.prevLeader === null) {
        // 领头刚出现: virt 原地不动（箭头保持流动相位，队列汇入; 偏差交由微漂移收敛）
        st.prevLeader = leader;
      } else {
        // 跟随领头的实际位移（内插帧增量; 吸收/换领头的回退 ≤0 钳 0——mod 1 连续）
        const leaderDelta = leader - st.prevLeader;
        let adv = Math.max(0, leaderDelta);
        if (leaderDelta > 0 && frameFlow > 0) {
          // 微漂移: 把常数相位偏移（注入/非整格领头回退遗留）以 ≤10% 带速收敛回
          // v11 精确对齐（队列停走时不漂移——箭头必须与队列同停）
          const offset = ((leader - st.virt) % 1 + 1.5) % 1 - 0.5; // wrap 到 (−0.5, 0.5]
          const driftCap = Math.min(0.1 * frameFlow, Math.abs(offset));
          adv += Math.sign(offset) * driftCap;
        }
        st.virt += adv;
        st.prevLeader = leader;
      }
    }
    for (const { handle, seg } of segs) {
      const st = this.chains.get(seg.chainId)!;
      out.set(handle, (((st.virt - (seg.segmentIndex ?? 0)) % 1) + 1) % 1);
    }
    for (const id of this.chains.keys()) {
      if (!seenChains.has(id)) this.chains.delete(id);
    }
    return out;
  }
}

/** chainId → [0,1) 确定性偏移（与 BeltPointerRenderer.chainPhaseOf 同式，播种用）。 */
function chainPhaseOf(chainId: string): number {
  let h = 0;
  for (let i = 0; i < chainId.length; i++) {
    h = (h * 31 + chainId.charCodeAt(i)) % 997;
  }
  return h / 997;
}
