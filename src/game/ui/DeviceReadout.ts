// 设备读数 — T2.9b 选中设备最小读数（**临时件**，T2.15 弹窗落地时吸收移除）
// 依据: implementation-phase-2.md T2.9（2026-08-24 修订版 9b）
//
// 纯格式化函数: BuildingComp 缓冲区 → 单行文本。main.ts 用单个 Pixi Text
// 4Hz 节流渲染（T1.10 文本节流先例），放屏幕空间层（不随 Ctrl+R 视图旋转）。
// 明确不做: 弹窗容器、多行排版、图标、进度条、样式——全部留给 T2.15。
//
// 非生产设备（无任何槽位的 def，如 T2.12 仓库取/存货口）返回 null——
// 读数不显示任何数据（2026-08-24 用户澄清：它们没有缓冲区可读）。

import type { BuildingComp } from '../components/BuildingComp.ts';
import type { BuildingDefinition } from '../data/buildings.ts';

/** 槽位数组求和（count 总量）。 */
const sumCount = (slots: BuildingComp['bufferInput']): number =>
  slots.reduce((n, s) => n + s.count, 0);

/**
 * 格式化选中设备的读数文本。
 * @returns "输入: x/cap　输出: y/cap" 单行；def 无任何缓冲槽位 → null（不显示）。
 */
export function deviceReadoutText(
  comp: BuildingComp,
  def: BuildingDefinition,
): string | null {
  if (def.inputSlotCount <= 0 && def.outputSlotCount <= 0) return null;
  const cap = def.bufferCapacity;
  return `输入: ${sumCount(comp.bufferInput)}/${cap}　输出: ${sumCount(comp.bufferOutput)}/${cap}`;
}
