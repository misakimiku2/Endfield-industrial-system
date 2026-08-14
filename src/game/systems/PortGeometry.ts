// 端口几何 — 设备端口世界格/朝向计算的单一事实来源（纯函数）
// 依据: A3 building-spec.md §2.2 (Port 旋转数学)
//
// T2.6 从 BeltCreationSystem 抽出（函数体原样搬运）: 传送带创建的端口高亮
// 与 MachineSystem 的端口吸入（T2.6 输入 / T2.7 输出 / T2.10 轮询）必须算出
// **相同的端口格**，两处各持一份拷贝一旦发散，传送带连接判定就会与实际端口错位。
//
// 方向约定（与 BuildingComp.Direction 一致）: 0°=右(+x), 90°=下(+y), 180°=左(-x), 270°=上(-y)。
// 旋转与设备 Sprite 渲染旋转一致（T2.0 验收: 高亮输出端口与渲染对齐）。

import type { Direction } from '../components/BuildingComp.ts';
import type { Port } from '../data/buildings.ts';

/** 把端口相对位置按建筑朝向旋转，得到在世界坐标系中的相对位置。 */
export function rotatePort(
  port: Port,
  footprint: { w: number; h: number },
  direction: Direction,
): { dx: number; dy: number } {
  const cx = (footprint.w - 1) / 2;
  const cy = (footprint.h - 1) / 2;
  const x = port.position.dx - cx;
  const y = port.position.dy - cy;
  let rx = x;
  let ry = y;
  switch (direction) {
    case 0:
      break;
    case 90:
      rx = -y;
      ry = x;
      break;
    case 180:
      rx = -x;
      ry = -y;
      break;
    case 270:
      rx = y;
      ry = -x;
      break;
  }
  return {
    dx: Math.round(rx + cx),
    dy: Math.round(ry + cy),
  };
}

/** 端口在默认方向下的朝外方向。 */
export function portOutwardBase(
  port: Port,
  footprint: { w: number; h: number },
): Direction {
  const { dx, dy } = port.position;
  if (dy === 0) return 270; // 顶边端口朝上
  if (dy === footprint.h - 1) return 90; // 底边端口朝下
  if (dx === 0) return 180; // 左边端口朝左
  if (dx === footprint.w - 1) return 0; // 右边端口朝右
  // 非边缘端口按上处理（防御性，当前数据不会出现）
  return 270;
}

/** 把一个基础方向按建筑朝向旋转。 */
export function rotateDirection(base: Direction, direction: Direction): Direction {
  return ((base + direction) % 360) as Direction;
}
