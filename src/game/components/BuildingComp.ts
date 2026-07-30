// 建筑组件 — 标记一个 Entity 是"已放置的设备"
// 依据: A3 building-spec.md §3 (BuildingComponent)、§3.3 (方向约定)、DD-002 (纯数据)
//
// Phase 1 范围 (T1.7): 只放置不生产，故 BuildingComponent 只需放设备要用的字段——
//   definitionId (指向 BuildingDefinition) + direction (世界朝向) + state (恒 idle)。
//   缓冲区/计时/轮询指针等生产字段 (A3 §3 的 BufferSlot/currentRecipeId/progress/elapsed/
//   bufferInput/bufferOutput/inputPollIndex/outputPollIndex) 是 Phase 2 生产系统才用，
//   本会话不加，避免引入未使用的复杂结构。Phase 2 接生产逻辑时扩展此 Component。
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
 * 建筑组件 (Phase 1 最小版)。
 * 一个 Entity 带 BuildingComp 即表示"这是一个已放置的设备"。
 * 配合 Position(左上角世界坐标) + SpriteComp(渲染描述) 完成设备的完整描述。
 */
export interface BuildingComp {
  /** 对应 BuildingDefinition.id (A3 §1)。运行时通过 getBuildingDefinition(id) 取完整定义。 */
  definitionId: string;
  /** 世界朝向 (A3 §3.3)。Phase 1 放置时由 PlacementSystem 写入，落盘后不再改变
   *  (Phase 1 不支持改变已放置设备朝向，放错靠 Phase 1.9 删除重建)。 */
  direction: Direction;
  /**
   * 设备状态 (A3 §4 状态机)。Phase 1 设备不生产，恒 'idle'。
   * Phase 2 接生产逻辑后扩展为 'idle' | 'working' | 'blocked' | 'no_power'。
   */
  state: 'idle';
}
