// 放置朝向策略 — 纯函数（T2.12 引入）
// 依据: A3 §6"旋转后占地不变"、implementation-phase-2.md T2.12 朝向约束
//
// 非正方形占地（如 3×1 仓库口）旋转 90° 后，rotatePort 会把端口旋出占地、
// Sprite 视觉与 OccupancyMap 占地错位——A3 §6 约定占地不随朝向交换宽高，
// 故非正方形设备只允许 0°/180° 两档（R 键步进 180°）；正方形设备四档循环。
// PlacementSystem.onKeyDown('KeyR') 调用本函数决定下一个 screenAngle。

/** 放置预览的屏幕呈现角（0/90/180/270）。 */
export type ScreenAngle = 0 | 90 | 180 | 270;

/**
 * 按一次 R 后的下一个屏幕呈现角。
 * @param current 当前屏幕呈现角
 * @param footprint 占地（正方形 → 90° 步进四档；非正方形 → 180° 步进两档）
 */
export function nextScreenAngle(
  current: ScreenAngle,
  footprint: { w: number; h: number },
): ScreenAngle {
  const step = footprint.w === footprint.h ? 90 : 180;
  return ((current + step) % 360) as ScreenAngle;
}
