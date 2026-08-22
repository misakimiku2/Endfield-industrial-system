// 传送带段组件 — T2.0 阶段1 基础创建
// 依据: implementation-phase-2.md T2.0 §数据模型、A9 §6.2 (Chain)
//
// 每个传送带段是一个独立 ECS Entity，占 1×1 Cell。
// Phase 1 先记录 chainId / direction / isCorner / isTail，为阶段 2 的链管理、
// 延长、删除打好基础。T2.1/T2.2 物品移动时会与 LogisticsComp 统一。

import type { Direction } from './BuildingComp';

/**
 * 传送带上的物品 (A9 §2.1)。
 *
 * 每一段传送带独立追踪自己上面的物品队列（`BeltSegmentComp.items`）。
 * - `itemId`: 物品类型 id，对应 items 图集的 textureKey（如 'cuprium_ore'）。
 * - `progress`: 0.0~1.0，物品在该段传送带上的归一化位置（0=段首，1=段尾）。
 *   每 Simulation Tick 推进 +0.025（0.5 格/秒 × 50ms / 64px），跨一整段需 40 Tick / 2 秒 (A9 §2.2)。
 */
export interface BeltItem {
  itemId: string;
  /** 段内归一化位置。正常范围 0.0~1.0；端口穿越格扩展: 设备输出注入从 -0.5（端口格中心）
   *  出发、预约进入设备的物品推进到 1.5（端口格中心）后移除（2026-08-17 用户选型，
   *  "物品要走到端口格中心才算进入设备"）。断头/堵塞停止时钳制为 STOP_MAX(0.5) 格中心。 */
  progress: number;
  /**
   * 本 Simulation Tick 的 progress 增量，渲染层用于帧间插值（消除 20TPS 逻辑阶跃在 60FPS 下的卡顿）。
   * 流动物品 = +0.025；停止/被间距夹住不动的物品 = 0（渲染静止，不插值）。
   * 由 BeltSystem 每 tick 写入，BeltItemRenderer 读取。
   */
  delta: number;
  /**
   * 端口预约标记（T2.6 修订）: true = 已在门口（progress 0.5）通过 tryAcceptItem 预约
   * 进入设备（输入槽已 count+1），BeltSystem 放行其推进到 1.5（端口格中心），
   * 由 MachineSystem 在 ≥1.5 时从 items[] 移除（视觉消失）。预约制防多端口争抢
   * （槽在门口判定瞬间即占用，"堵塞停在供给格中心"与"预约放行"解耦）。
   */
  entering?: boolean;
}

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
  /**
   * 该段上的物品队列 (A9 §2.1)。T2.1 起由 BeltSystem 每 Tick 推进 progress。
   * 创建时初始化为 `[]`；T2.6 起物品从设备输出端口注入，T2.2 起跨段传输。
   * 渲染: items 非空时隐藏该段 pointer (A9 §5.2.2)，由 BeltItemRenderer 渲染物品。
   */
  items: BeltItem[];
  /**
   * 堵塞状态 (传送带堵塞视觉): 本段队首非 entering 物品被堵停（delta=0）时为 true。
   * 由 BeltSystem 每 Tick 重算写入（空段恒 false），渲染层据此把带身 Status 黄带染红、
   * 流动箭头染 #E6956F。断头/满槽/下游占用均触发；正在吸入(entering)不算堵塞。
   */
  blocked?: boolean;
}
