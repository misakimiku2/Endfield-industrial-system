// 仓库取/存货口操作 — T2.12 简化版（无限源 / 无限汇）
// 依据: implementation-phase-2.md T2.12（2026-08-24 用户澄清版）、A9 §6.7(端口连接判定)、
//       一格一物品规则、T2.6 预约制吸入、T2.7 注入纪律
//
// 纯逻辑模块 (DD-011，IntakeOps/OutputOps 先例)。取货口/存货口**不是生产设备**——
// 没有配方、没有缓冲区、没有生产计时，由 MachineSystem 每 Tick 对 def.depot 设备调用：
//   - 取货口 (depot='unload'): 每个输出口找接收带，凭空放出 1 件源物品（无限源，
//     不建模内部库存）。注入纪律与 T2.7 完全同律: 只往空段注入 + **段首 progress=0**
//     （2026-08-25 退役全局相位窗口，物品进度独立推进）+ 每端口每 Tick 至多 1 件
//     → 空带吞吐 1 件/2 秒/口。
//   - 存货口 (depot='load'): 每个输入口走 T2.6 预约制吸入，但**无条件接受**——
//     无槽位/类型/容量判定（无限汇，永不堵塞），物品预约后由 BeltSystem 放行
//     推进到端口格中心(1.5)走进设备半格深处消失（releaseArrivedItems 复用）。

import type { BeltSegmentComp } from '../../components/BeltSegmentComp.ts';
import { PORT_ENTER_PROGRESS } from './IntakeOps.ts';

/**
 * 简化版取货口的输出物品（固定源矿）。产出物品配置界面属 T2.15 设备弹窗，
 * 届时改为 BuildingDefinition 字段驱动。
 */
export const DEPOT_SOURCE_ITEM = 'originium_ore';

/**
 * 从取货口放一件源物品到传送带段首（T2.7 tryEmitToBelt 的无槽位变体）。
 * 纪律完全同律: 注入**段首 progress=0**（2026-08-25 退役 beltPhase 相位窗口——
 * 物品进度独立推进，无后跳之虞）、只往空段注入（一格一物品）。
 * @returns 放出的 itemId；null = 段上已有物品。
 */
export function emitSourceToBelt(
  seg: BeltSegmentComp,
  itemId: string = DEPOT_SOURCE_ITEM,
): string | null {
  const items = seg.items ?? (seg.items = []);
  if (items.length > 0) return null;
  items.push({ itemId, progress: 0, delta: 0 });
  return itemId;
}

/**
 * 尝试预约段上队首物品进入存货口（T2.6 tryAbsorbHeadItem 的无条件变体）。
 * 队首 progress ≥ PORT_ENTER_PROGRESS(0.5) 即接受——无槽位/类型/容量判定
 * （无限汇）。物品不移除，标记 entering 由 BeltSystem 放行至 1.5、
 * releaseArrivedItems 移除（走进设备半格深处消失）。
 * @returns 预约的 itemId；null = 段上无可预约物品 / 队首未到门口。
 */
export function tryAbsorbHeadItemSink(seg: BeltSegmentComp): string | null {
  const items = seg.items;
  if (!items || items.length === 0) return null;
  let head = null as (typeof items)[number] | null;
  for (const it of items) {
    if (it.entering) continue;
    if (head === null || it.progress > head.progress) head = it;
  }
  if (head === null || head.progress < PORT_ENTER_PROGRESS) return null;
  head.entering = true;
  return head.itemId;
}
