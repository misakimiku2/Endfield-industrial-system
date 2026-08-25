// 建筑组件 — 标记一个 Entity 是"已放置的设备"
// 依据: A3 building-spec.md §3 (BuildingComponent)、§3.3 (方向约定)、DD-002 (纯数据)
//
// Phase 1 范围 (T1.7): 只放置不生产，故只放设备要用的字段——
//   definitionId (指向 BuildingDefinition) + direction (世界朝向) + state (恒 idle)。
// Phase 2 按任务扩展: T2.4 加 bufferInput（输入缓冲区）；
//   T2.5 加 bufferOutput + 生产计时字段（currentRecipeId/progress/elapsed，A3 §3/A8 §3.1），
//   state 扩展为完整状态机 'idle' | 'working' | 'blocked'（A8 §6）；
//   T2.8 加 paused（玩家手动暂停）；T2.10 加端口轮询状态（inputPollIndex 指针 +
//   outputPollQueue 活跃队列，A3 §3.2/A8 §4）。
//
// direction (A3 §3.3) 是**世界相对**存储的朝向 (存档/模拟都用世界朝向):
//   0°=朝右, 90°=朝下, 180°=朝左, 270°=朝上。
//   玩家按 R 键旋转时的手感是**相对视图**的 (屏幕上看起来转 90°)，换算关系见
//   PlacementSystem (世界朝向 = 屏幕朝向 − viewRotation, A6 §4.0)。

/**
 * 设备朝向（世界相对）。A3 §3.3: 0°=右, 90°=下, 180°=左, 270°=上。
 * 存档/模拟/轮询都用世界朝向；玩家按 R 的屏幕手感由 PlacementSystem 做相对视图换算。
 */
export type Direction = 0 | 90 | 180 | 270;

/**
 * 设备状态机 (A8 §6)。
 * idle: 空闲无计时；working: 生产计时推进中（原料未扣）；blocked: 输出满、结算暂缓。
 */
export type MachineState = 'idle' | 'working' | 'blocked';

/**
 * billboard LOGO 的视觉状态 (T2.8)。由 resolveLogoState 从 (paused, state) 派生：
 * normal = 设备主体纹理 + 原 LOGO；paused = 深灰暂停图标；blocked = 红 X 图标。
 */
export type LogoVisualState = 'normal' | 'paused' | 'blocked';

/**
 * LOGO 视觉状态解析 (T2.8)：paused 与 blocked 同时成立时优先显示暂停图标
 * （玩家主动操作意图优先于被动暂缓，implementation-phase-2.md T2.8 需求1）。
 */
export function resolveLogoState(paused: boolean, state: MachineState): LogoVisualState {
  if (paused) return 'paused';
  if (state === 'blocked') return 'blocked';
  return 'normal';
}

/**
 * 缓冲区槽位 (A3 §3、A8 §2)。
 * 输入槽: itemId === null 表示空/未锁定；非 null 表示锁定该类型（只进同类），
 *   count 降为 0 时解锁 (A8 §2.1)。
 * 输出槽: 一槽一物 (A8 §2.2)，语义对称。
 */
export interface BufferSlot {
  /** 锁定的物品类型；null = 空槽未锁定 */
  itemId: string | null;
  /** 当前数量（上限 = BuildingDefinition.bufferCapacity，默认 50） */
  count: number;
}

/**
 * 建筑组件。一个 Entity 带 BuildingComp 即表示"这是一个已放置的设备"。
 * 配合 Position(左上角世界坐标) + SpriteComp(渲染描述) 完成设备的完整描述。
 */
export interface BuildingComp {
  /** 对应 BuildingDefinition.id (A3 §1)。运行时通过 getBuildingDefinition(id) 取完整定义。 */
  definitionId: string;
  /** 世界朝向 (A3 §3.3)。Phase 1 放置时由 PlacementSystem 写入，落盘后不再改变
   *  (Phase 1 不支持改变已放置设备朝向，放错靠 Phase 1.9 删除重建)。 */
  direction: Direction;
  /**
   * 设备状态 (A3 §4 状态机，A8 §6)。由 MachineSystem 在生产循环中迁移。
   */
  state: MachineState;
  /**
   * 玩家手动暂停 (T2.8)。true = 生产/物流视同离线：不推进计时（已走进度保留，
   * 恢复后从暂停处继续）、不吸入输入、不输出产物；已预约(entering)物品仍放行完成
   * 视觉行程（槽位早在预约时占用）。与 blocked 互独立——blocked 是输出满被动暂缓，
   * paused 是玩家主动关停。正式入口是设备弹窗电源开关 (T2.15)，当前由调试钩子驱动。
   */
  paused: boolean;
  /**
   * 输入缓冲区 (A8 §2.1，T2.4)。长度 = BuildingDefinition.inputSlotCount，
   * 放置时初始化为全空槽，生产系统运行期间读写。
   */
  bufferInput: BufferSlot[];
  /**
   * 输出缓冲区 (A8 §2.2，T2.5)。长度 = BuildingDefinition.outputSlotCount，一槽一物。
   * 原子结算时产物加入此处（液体产物走 liquid 端口不占槽，A8 §2.2 注）。
   */
  bufferOutput: BufferSlot[];
  /** 当前生产配方 id (A8 §3.1，T2.5)。null = 空闲，无生产计时。单设备单计时器。 */
  currentRecipeId: string | null;
  /** 生产进度 0~1 (A8 §3.1)。progress = elapsed / totalTime，totalTime 从 Recipe.time 读取。 */
  progress: number;
  /** 已消耗生产时间 ms (A8 §3.2)。每 Tick +50ms，不存 Component 之外的派生量。 */
  elapsed: number;
  /**
   * 输入轮询指针 (A8 §4.1/A3 §3.2，T2.10)。下一个尝试预约的输入端口下标——
   * inputPortCells 过滤序（定义序，即"左→中→右"连接序；设备旋转只改端口世界位置，
   * 不改定义序）。预约成功或端口跳过（无供给带/类型不符/未到门口）指针都 +1（mod n）；
   * 全部输入槽满载时冻结不动、不重置（A8 §4.1"轮询指针不重置"，精炼炉设备说明
   * "A 成功那么下一次应该直接轮到 B"）。放置时初始化 0。
   */
  inputPollIndex: number;
  /**
   * 输出轮询队列 (A8 §4.2，T2.10)。按当前轮询序排列的**活跃**输出端口下标
   * （outputPortCells 过滤序）。出货成功的端口移到队尾（轮转）；出货失败的端口
   * （无接收带 / 满带一格一物品）移出队列——堵塞集 = 全部输出端口 − 本队列
   * （派生值不落盘，DD-012 存档只需保存本字段），恢复探测成功后追加到队尾
   * （A8 §4.2"追加到当前轮询顺序的末尾，不插回原位"）。放置时初始化为全部端口。
   */
  outputPollQueue: number[];
}
