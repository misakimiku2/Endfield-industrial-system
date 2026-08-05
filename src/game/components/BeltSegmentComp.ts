// 传送带段组件 — T2.0 阶段1 基础创建
// 依据: implementation-phase-2.md T2.0 §数据模型、A9 §6.2 (Chain)
//
// 每个传送带段是一个独立 ECS Entity，占 1×1 Cell。
// Phase 1 先记录 chainId / direction / isCorner / isTail，为阶段 2 的链管理、
// 延长、删除打好基础。T2.1/T2.2 物品移动时会与 LogisticsComp 统一。

import type { Direction } from './BuildingComp';

/**
 * 传送带段组件。
 *
 * 渲染相关字段（entryDir/mirrorH）由 BeltPathGeometry.getCellTurnInfo/beltCornerTransform
 * 在落盘时计算并写入，供 RenderSystem 直接读取，保证「预览 ↔ 落盘 ↔ 渲染」三方一致。
 */
export interface BeltSegmentComp {
  /** 所属链 ID，同一次创建/延长的段共享（阶段 2 完整使用）。 */
  chainId: string;
  /** 段朝向：0°=右, 90°=下, 180°=左, 270°=上。直段=本段流向；转角段=出口方向。 */
  direction: Direction;
  /** 是否为转角段（入方向 ≠ 出方向）。 */
  isCorner: boolean;
  /** 转角段的进入方向（仅 isCorner=true 时有效；直段无意义）。 */
  entryDir?: Direction;
  /** 转角段是否需要水平镜像（CCW 转弯）。仅 isCorner=true 时有意义。 */
  mirrorH?: boolean;
  /** 是否为链末端（可被继续延长）。 */
  isTail: boolean;
  /**
   * 链首格继承的进入方向（来自源端：设备输出端口的反向 / 断头段方向）。
   * 仅链首格 (path index 0) 写入，用于首格转角渲染判断。
   * 与旧项目 ConveyorBelt.incomingDirection 对应。
   */
  incomingDirection?: Direction;
  /** 链内序号（0=链首）。落盘时按链内位置写入，pointer 沿链流动定位用。 */
  segmentIndex: number;
  /** pointer 流动相位偏移（0~1），落盘时随机生成，避免所有传送带同步流动。T2.0 阶段1 pointer 动画用。 */
  phaseOffset: number;
}
