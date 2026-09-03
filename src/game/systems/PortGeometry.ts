// 端口几何 — 设备端口世界格/朝向计算的单一事实来源（纯函数）
// 依据: A3 building-spec.md §2.2 (Port 旋转数学)
//
// T2.6 从 BeltCreationSystem 抽出（函数体原样搬运）: 传送带创建的端口高亮
// 与 MachineSystem 的端口吸入（T2.6 输入 / T2.7 输出 / T2.10 轮询）必须算出
// **相同的端口格**，两处各持一份拷贝一旦发散，传送带连接判定就会与实际端口错位。
//
// 方向约定（与 BuildingComp.Direction 一致）: 0°=右(+x), 90°=下(+y), 180°=左(-x), 270°=上(-y)。
// 旋转与设备 Sprite 渲染旋转一致（T2.0 验收: 高亮输出端口与渲染对齐）。
// T2.17: 非正方形占地 90°/270° 旋转时宽高互换（buildings.ts effectiveFootprint），
// rotatePort 公式已按互换后的占地给出端口格——仓库口等四向旋转后端口不旋出占地。

import type { Direction } from '../components/BuildingComp.ts';
import type { Port, BuildingDefinition } from '../data/buildings.ts';

/** 端口世界格（Grid 坐标）。 */
export interface PortCell {
  /** 端口定义（ports 数组内的原始引用）。 */
  port: Port;
  x: number;
  y: number;
  /** 端口朝外方向（世界坐标，已按建筑朝向旋转）。2026-09-02 起输入对接判定用:
   *  供给格恒为端口格 + directionVector(outward)，传送带只能从朝向侧指入连接
   *  （用户拍板"接 (2,0) 只能经下方 (2,1)，不能从 (3,0) 侧向横穿"）。 */
  outward: Direction;
}

/**
 * 计算设备全部**输入**端口的世界格（按定义顺序，即"左→中→右"连接序）。
 * T2.16 起由 BeltSystem（真堵分类）与 IntakeOps（吸入判定）共用——原实现于
 * IntakeOps，BeltSystem 不能反向导入 machine/（IntakeOps 依赖 BeltSystem 的
 * STOP_MAX，会成环），故下沉到本共享模块，IntakeOps 再导出保持旧导入路径兼容。
 * 输出/液体端口不在其中（output 由 T2.7 处理、liquid 由 Phase 2+ 处理）。
 * @param gx gy 建筑左上角格坐标（Position / CELL_SIZE）
 */
export function inputPortCells(
  gx: number,
  gy: number,
  def: BuildingDefinition,
  direction: Direction,
): PortCell[] {
  const cells: PortCell[] = [];
  for (const port of def.ports) {
    if (port.type !== 'input') continue;
    const o = rotatePort(port, def.footprint, direction);
    cells.push({
      port,
      x: gx + o.dx,
      y: gy + o.dy,
      outward: rotateDirection(portOutwardBase(port, def.footprint), direction),
    });
  }
  return cells;
}

/**
 * 把端口相对位置按建筑朝向旋转，得到在世界坐标系中的相对位置。
 *
 * T2.17 起旋转感知占地宽高互换（effectiveFootprint）: 90°/270° 时占地从 w×h 变为
 * h×w，公式直接在新占地的左上角坐标系给出结果（对正方形占地与旧"绕中心旋转"数学
 * 完全等价——正方形 w=h 时不换占地，两式逐点相等）。
 * 旋转约定与 Sprite 渲染一致: 90° = 顺时针（0°=右 → 90°=下）。
 */
export function rotatePort(
  port: Port,
  footprint: { w: number; h: number },
  direction: Direction,
): { dx: number; dy: number } {
  const { dx, dy } = port.position;
  const { w, h } = footprint;
  switch (direction) {
    case 0:
      return { dx, dy };
    case 90: // 顺时针 90°: 占地变 h×w，顶边端口 → 右边
      return { dx: h - 1 - dy, dy: dx };
    case 180:
      return { dx: w - 1 - dx, dy: h - 1 - dy };
    case 270: // 逆时针 90°: 占地变 h×w，顶边端口 → 左边
      return { dx: dy, dy: w - 1 - dx };
  }
}

/**
 * 端口在默认方向下的朝外方向。
 * h=1 顶/底边歧义（dy=0 同时是顶行和底行，2026-09-02 显式消解；T2.19 修订）:
 * **一律朝上（270）**——取货口带从上方接出、存货口带从上方落入，两台设备接带面
 * 一致（2026-09-04 用户拍板: 旧版"输入口朝下"与设备外观指示相反，用户实测困惑
 * "方向反了，只能从下方连接"）。边缘判定仅对多行占地生效（如精炼炉底行输入口）。
 */
export function portOutwardBase(
  port: Port,
  footprint: { w: number; h: number },
): Direction {
  const { dx, dy } = port.position;
  if (dy === 0) {
    if (footprint.h === 1) return 270; // 1 格高: 端口一律朝上（T2.19，接带面统一在顶侧）
    return 270; // 顶边端口朝上
  }
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
