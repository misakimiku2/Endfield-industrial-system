// 缓冲区操作 — 纯函数 (DD-011 状态在 Component，逻辑按 belt/BeltChainOps 先例独立成 ops 模块)
// 依据: A8 §2.1 (输入槽规则)、A3 §3 (BufferSlot)
//
// 输入槽规则 (A8 §2.1):
//   - 每个输入槽独立运作，槽空时下一件物品决定其类型（锁定 itemId）
//   - 锁定期间只接受同类型物品；不同类型可尝试其他空槽；全都不接受 → false（物品留在传送带）
//   - count 降为 0 时解锁（itemId = null），下一件物品重新决定类型
//
// 槽选择顺序: 先找"已锁定同类型且未满"的槽（同类合堆，不拆堆），
// 再找第一个空槽锁定新类型。同类型优先并入已锁定槽是本实现的补充约定
// （A8 未规定多槽偏好，合堆直觉上正确且对单槽设备无差异）。
//
// T2.5 生产计时/结算、T2.8 输出槽逻辑在本模块上继续扩展。

import type { BufferSlot } from '../../components/BuildingComp.ts';

/** 创建 n 个空槽（放置设备时按 definition.inputSlotCount 初始化）。 */
export function createBufferSlots(n: number): BufferSlot[] {
  return Array.from({ length: n }, () => ({ itemId: null, count: 0 }));
}

/**
 * 尝试让一件物品进入输入缓冲区。
 * @returns true = 进入成功（某槽 count+1，必要时锁定类型）；false = 所有槽都不接受
 */
export function tryAcceptItem(slots: BufferSlot[], itemId: string, capacity: number): boolean {
  for (const slot of slots) {
    if (slot.itemId === itemId && slot.count < capacity) {
      slot.count++;
      return true;
    }
  }
  for (const slot of slots) {
    if (slot.itemId === null) {
      slot.itemId = itemId;
      slot.count = 1;
      return true;
    }
  }
  return false;
}

/**
 * 从槽中扣减 n 件（原子结算扣原料用）。count 到 0 时解锁类型 (A8 §2.1)。
 * 扣减超量时钳到 0（防御，正常调用方已保证 count >= n）。
 */
export function consumeFromSlot(slot: BufferSlot, n: number): void {
  slot.count = Math.max(0, slot.count - n);
  if (slot.count === 0) slot.itemId = null;
}

/**
 * 格式化缓冲区为控制台/调试输出（T2.4 验收格式）。
 * @param nameOf itemId → 显示名（传物品注册表的 name 查询）
 */
export function formatBufferSlots(
  slots: BufferSlot[],
  capacity: number,
  nameOf: (itemId: string) => string,
): string {
  return slots
    .map((slot, i) =>
      slot.itemId === null || slot.count === 0
        ? `输入槽${i}: 空`
        : `输入槽${i}: ${nameOf(slot.itemId)} × ${slot.count}/${capacity} (已锁定)`,
    )
    .join('\n');
}
