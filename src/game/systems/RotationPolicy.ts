// 放置朝向策略 — 纯函数（T2.12 引入，T2.17 修订）
// 依据: A6 §4.0 viewRotation 参考系、implementation-phase-2.md T2.17 朝向修订
//
// T2.17 起所有设备 R 键一律 90° 四档循环: 90°/270° 旋转时非正方形占地宽高互换
// （3×1 仓库口 ↔ 1×3，见 buildings.ts effectiveFootprint），端口旋转数学对任意
// 占地自洽，不再需要"非正方形只允许 0°/180° 两档"的特例。
// PlacementSystem.onKeyDown('KeyR') 调用本函数决定下一个 screenAngle。

/** 放置预览的屏幕呈现角（0/90/180/270）。 */
export type ScreenAngle = 0 | 90 | 180 | 270;

/**
 * 按一次 R 后的下一个屏幕呈现角（屏幕顺时针 +90°，四档循环）。
 * @param current 当前屏幕呈现角
 */
export function nextScreenAngle(current: ScreenAngle): ScreenAngle {
  return ((current + 90) % 360) as ScreenAngle;
}
