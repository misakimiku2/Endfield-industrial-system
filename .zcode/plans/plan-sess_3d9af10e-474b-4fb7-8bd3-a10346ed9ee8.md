# T1.7 设备放置系统 — 实现计划

## 范围与产物

本会话只做 T1.7 的核心闭环：**工具栏选设备 → 左键放网格交叉点 → R 键旋转预览（相对视图）→ 右键/ESC 取消**。不做 T1.8 选中、T1.9 删除、建造成本。

### 新建文件（5 个）
1. `src/game/data/buildings.ts` — `BuildingDefinition` 数据表（DD-003 数据驱动）
2. `src/game/components/BuildingComp.ts` — `BuildingComponent` 纯数据接口（DD-002）
3. `src/game/world/OccupancyMap.ts` — 占用表（A2 §7.1）
4. `src/game/systems/PlacementSystem.ts` — 放置预览 + 放置落盘系统
5. `src/game/ui/InventoryUI.ts` — **重写**空壳为工具栏（PixiJS Container，钉 overlayLayer）

### 改动文件（2 个）
6. `src/game/Game.ts` — 持有 `OccupancyMap`、`PlacementSystem`、`InventoryUI`；`update()` 调 PlacementSystem
7. `src/main.ts` — 装配 InventoryUI（挂 overlayLayer）、接入 PlacementSystem 的键盘/鼠标、暴露验收钩子

---

## 模块设计

### 1. `src/game/data/buildings.ts`（新建）

依据 A3 §1（BuildingDefinition）、§1.1（首批设备）、§2.1（Port）。**严格按 building-spec §1.1 的 7 个设备建表**，Phase 1 只用到字段：`id / name / category / footprint / ports / texture / selectable`。`buildCost / powerConsumption / inputSlotCount / outputSlotCount / bufferCapacity` 这些是 Phase 2 生产字段，**字段保留在接口里但 Phase 1 建表时也照填**（building-spec §1.1 都给了值，照抄无害，省得 Phase 2 再补）。

```ts
// 接口严格对齐 A3 §1
export interface BuildingDefinition { /* A3 §1 完整字段 */ }
export const BUILDING_DEFINITIONS: Record<string, BuildingDefinition>; // 7 个设备
export function getBuildingDefinition(id: string): BuildingDefinition | undefined;

// 工具栏展示用：Phase 1 选 4 个（覆盖 3×3 + 5×5 footprint）
export const TOOLBAR_BUILDINGS: string[]; // ['refining_unit','shredding_unit','fitting_unit','seed_picking_unit']
```

**工具栏 4 个设备**（用户选定的方案 1）：`refining_unit`(3×3, 有真实纹理) / `shredding_unit`(3×3) / `fitting_unit`(3×3) / `seed_picking_unit`(5×5)。后 3 个缺 SVG → 占位图。选 seed_picking_unit 是因为它是 5×5，能测大占地 + 接近世界边界的占用检查。

### 2. `src/game/components/BuildingComp.ts`（新建）

依据 A3 §3 / §3.3（方向）、DD-002（纯数据）。**Phase 1 只放置不生产**，所以 BuildingComponent 只需放设备要用的字段：

```ts
export type Direction = 0 | 90 | 180 | 270;  // 世界相对存储（A3 §3.3）
export interface BuildingComp {
  definitionId: string;
  direction: Direction;   // 世界朝向（存档/模拟用世界相对）
  state: 'idle';          // Phase 1 恒 idle，Phase 2 接生产时扩展状态机
}
```

**关键**：缓冲区/计时/轮询指针等生产字段（A3 §3）**本会话不加**。Phase 2 开生产系统时再扩 BuildingComponent。A3 §3 的 BuildingComponent 是"完整版"，Phase 1 的放置只需要 definitionId + direction。

### 3. `src/game/world/OccupancyMap.ts`（新建）

依据 A2 §7.1。**不进 ECS**（它是 WorldData 持有的世界结构，不是 Component）：

```ts
export class OccupancyMap {
  private grid = new Map<string, string>();  // key "gx,gy" → definitionId
  constructor(private map: MapInstance) {}   // 读 map.widthCells/heightCells 做边界

  private inBounds(gx, gy): boolean { return gx>=0 && gy>=0 && gx<this.map.widthCells && gy<this.map.heightCells; }
  isOccupied(gx, gy): boolean;
  getOccupant(gx, gy): string | null;
  occupy(gx, gy, defId): void;
  release(gx, gy): void;
  canPlace(gx, gy, w, h): boolean;  // 全部 Cell 在界内 + 全部空闲
  occupyFootprint(gx, gy, def): void;  // 便利方法：遍历 footprint occupy
  releaseFootprint(gx, gy, def): void; // T1.9 删除用，本会话建好备用
  clear(): void;
}
```

**边界来源严格读 `MapInstance`**（用户强调的 T1.6 接口预留）：`canPlace` 查 `[0,widthCells)×[0,heightCells)`，不读全局常量。为 Phase 3a Chunk 化铺路。

### 4. `src/game/ui/InventoryUI.ts`（重写空壳）

依据 T1.7 工具栏技术选型。**PixiJS Container，挂 overlayLayer（层 6，屏幕空间），不进 worldContainer**。这样钉死屏幕底部，不受 Ctrl+R 旋转、相机平移/缩放影响。

```
InventoryUI（Container，加到 overlayLayer）
├─ 背景条 Container（Graphics 画半透明深色底条 + 圆角）
└─ 按钮组 Container（N 个按钮横排）
   每个 BuildingButton:
   ├─ Graphics 背景（hover/active 态描边变色）
   ├─ Sprite 设备图标（有纹理用 getTexture，缺纹理→程序化 Graphics 占位图）
   └─ Text 设备名（小字，底部）
```

**交互**：`eventMode: 'static'`，`pointerdown` 选中该设备 → 回调 `onSelect(definitionId)`；`stopPropagation()` 抑制相机拖拽。选中态：按钮描边高亮（绿色），其余按钮恢复正常态。

**占位图**（缺 SVG 设备）：`PlaceholderTextureFactory.create(def)` 生成一个 `Graphics` → `renderer.generateTexture()` → `Texture`，画 footprint 边框 + 设备名缩写 + 几个 Port 小方块标记。**缓存**到 Map<definitionId, Texture>，避免每次重生成。

**API**：
```ts
export class InventoryUI {
  constructor(overlayLayer, getTexture, onSelect: (id: string) => void);
  layout(): void;          // 根据 app.screen 宽度重新横排定位（resize 时调）
  setActive(id: string | null): void;  // 高亮选中态（null = 全部取消高亮）
}
```

### 5. `src/game/systems/PlacementSystem.ts`（新建）— **核心**

放置预览 + 放置落盘。**预览不进 ECS**（它是 UI 态，落盘才创建真实体）。预览半透明 Sprite 挂在 `layer2Building`（受相机变换支配），退出放置模式时移除。

#### 状态机
```
idle ──(工具栏选设备)──→ placing
placing ──(左键点地图 + canPlace✓)──→ placing(放下了，保持模式连放)
placing ──(右键 / ESC)──→ idle
placing ──(再点工具栏同设备)──→ idle(切换关闭)
```

#### R 键相对视图（**最易写错处，重点设计**）

依据 T1.7 R 键约定 + A6 §4.0 + A3 §3.3。

**核心策略**：预览维护的是**屏幕呈现角 `screenAngle`(0/90/180/270)**，按 R 永远 `screenAngle = (screenAngle + 90) % 360`。**绝不直接对 `direction` 加 90**——这是防止错误的根本。

```
预览渲染时（每帧）:
  sprite.rotation = (screenAngle 对应弧度)   ← 直接用屏幕角，所见即所得

落盘时（左键确认）:
  direction(世界) = (screenAngle - viewRotation + 360) % 360   ← A6 §4.0 公式
  存入 BuildingComponent.direction
```

**`sprite.rotation` 符号**（PixiJS rotation 正值=顺时针）：PixiJS 的 `rotation` 是对象自身顺时针旋转。设备 SVG 默认 0°朝向是"朝右"（A3 §3.3）。**需实测确认 `sprite.rotation = +screenAngle_rad` 还是 `-screenAngle_rad`**——纸面推导两种都可能（取决于 SVG 原图朝向与 PixiJS 坐标系 y 向下的相互作用）。计划里用 verify 脚本在 4 个 viewRotation 态实测 PixiJS 渲染来确定，**不在纸面猜**。

落盘后的真实体也带方向——RenderSystem 目前不读 direction 旋转 Sprite（Phase 1 设备是静态贴图，A3 §2.4 明确 Phase 2 才接动态表现）。**本会话 RenderSystem 不改**：真实体 Sprite 不旋转（朝向信息存在 BuildingComponent.direction 里，Phase 2 接视觉时再读）。这是符合"Phase 1 设备是静态贴图"的约定，验收标准只要求"设备按当前朝向固定"——固定的是 Position（网格交叉点），朝向的视觉表现留 Phase 2。

#### 放置落盘流程（A3 §5）
```
左键确认时:
1. screenPos = 鼠标屏幕坐标
2. worldPos = camera.screenToWorld(screenPos)
3. snapWorld = snapToCell(worldPos)   ← A2 §2.3，设备左上角世界坐标
4. gridPos = worldToCell(worldPos)    ← 左上角 Cell 坐标
5. footprint = def.footprint (w×h)
6. if (!occupancy.canPlace(gridPos.x, gridPos.y, w, h)) → 预览变红 + 抖动反馈，return
7. 创建真实体:
   - world.createEntity()
   - addComponent('Position', { x: snapWorld.x, y: snapWorld.y })
   - addComponent('BuildingComp', { definitionId, direction: 世界方向, state: 'idle' })
   - addComponent('SpriteComp', { group:'devices', textureKey:def.texture, width:w*CELL_SIZE, height:h*CELL_SIZE, layer:2 })
   - occupancy.occupyFootprint(gridPos, def)
8. RenderSystem 自动建 Sprite（已有逻辑）
9. 保持放置模式，可连放（验收"左键点另一个位置→第二个设备出现"）
```

**snapToCell 用 `Math.round`（A2 §2.3）**：吸附到最近的 Cell 交叉点（=Cell 左上角）。对 3×3 设备，吸附点 = footprint 左上角 Cell 左上角。

#### 预览跟随鼠标
每帧（`update()`）：
1. 若非 placing 态 → 隐藏预览 Sprite，return
2. worldPos = camera.screenToWorld(当前鼠标屏幕坐标)
3. snapWorld = snapToCell(worldPos); gridPos = worldToCell(worldPos)
4. 预览 Sprite 位置 = snapWorld（+半宽高居中，anchor 0.5）
5. 预览 Sprite.rotation = screenAngle
6. canPlace 检查 → 有效（半透明绿/正常 alpha）或无效（半透明红）变色反馈
7. **有效性变色**：用 `previewSprite.tint`（0xCCFFCC 有效 / 0xFF9999 无效），不改 alpha 以保持可见

#### 输入处理
PlacementSystem **不直接监听 DOM**——它在 `update(dt)` 里被主循环调用，输入由 main.ts 的统一监听转发。原因：CameraController 已占用 window 键盘/鼠标监听，避免双监听冲突。PlacementSystem 暴露方法：
```ts
onPointerDown(screenX, screenY, button: 0|2): void;  // main 的 canvas pointerdown 转发
onKeyDown(code: string): void;                        // main 的 keydown 转发（仅 'KeyR'/'Escape'）
update(dt: number): void;                             // 主循环调用，更新预览跟随
```

main.ts 的转发逻辑：
- canvas `pointerdown`：button 0 → `placement.onPointerDown(x,y,0)`；button 2 → `(x,y,2)`（取消）。**只在 placing 态消费左键**，非 placing 态左键交给 T1.8 选中（本会话不实现，预留）。
- window `keydown`：`KeyR`（裸 R，非 Ctrl/Cmd，且 placing 态）→ `placement.onKeyDown('KeyR')`；`Escape` → `onKeyDown('Escape')`。**R 监听只在 placing 态响应**（用户强调：别全局监听，免得非放置时按 R 误触发）。

#### CameraController 兼容
CameraController 已在 `onKeyDown` 拦截 `Ctrl/Cmd+KeyR`（preventDefault + rotateClockwise + return），**裸 KeyR 不触发视图旋转**。PlacementSystem 的 R 监听由 main.ts 转发，与 CameraController 不冲突——两套 R 靠 Ctrl 区分，符合用户要求。

---

## main.ts 装配改动

1. 实例化 `OccupancyMap`（传入 `game.worldData.map`）
2. 实例化 `PlacementSystem`（传入 world / occupancy / camera / sceneLayers / getTexture / map）
3. 实例化 `InventoryUI`（传入 overlayLayer / getTexture / onSelect 回调 → `placement.enterMode(defId)`）
4. 把 InventoryUI 的 Container 加到 `scene.layers.overlayLayer`
5. canvas 加 `pointerdown` 监听 → 转发给 placement（button 0/2）
6. window `keydown` 监听：裸 KeyR + Escape（placing 态）→ 转发给 placement
7. 主循环里 `game.update()` 后调 `placement.update(dt)`
8. 视口 resize 时调 `inventoryUI.layout()` 重新横排
9. 暴露验收钩子到 `__game`：`occupancy`、`placement`、`inventoryUI`、`placeAt(defId, gx, gy, dir)`（程序化放置，便于验收）、`getOccupiedCells()`（验证占用）

**保留** T1.6 的 `spawnTestDevices` / `clearTestDevices`（不冲突，它们是 SpriteComp 测试用，T1.7 用真实 BuildingComponent）。

---

## R 键符号的实测验证（关键）

计划中标注为"需实测"的 `sprite.rotation` 符号，**用 `scripts/verify-t1.7.ts` 在 4 个 viewRotation 态实测 PixiJS 渲染**：

1. 构造一个 Sprite，设 `rotation = +rad(screenAngle)`，在 viewRotation=0 时渲染，截图读像素确认设备"朝右"的边在屏幕右侧。
2. viewRotation=90 时，按 A6 §4.0 期望"屏幕朝向"相对世界旋转，验证 `sprite.rotation` 的符号让设备在屏幕上确实转了 screenAngle。
3. 同理 180/270。

**如果纸面符号错**，verify 脚本会立刻暴露（设备朝向与预期差 90/180°），改符号重测。这比在浏览器里肉眼猜可靠。

verify 脚本还覆盖：
- OccupancyMap：occupy/isOccupied/canPlace/release/inBounds/边界外 canPlace=false
- BuildingDefinition：7 个设备字段齐全、footprint 正确
- snapToCell + worldToCell：吸附到最近 Cell 交叉点
- R 键换算：4 个 viewRotation × 4 个 screenAngle = 16 组合，验证 `(screenAngle - viewRotation + 360) % 360` 落到预期世界方向
- 放置落盘：创建实体后查 Position/BuildingComp/SpriteComp 三组件 + occupancy 已占

---

## 验收对照（T1.7 验收标准逐条）

| 验收标准 | 实现点 |
|---------|--------|
| 底部看到一排按钮，上面有设备图标 | InventoryUI 挂 overlayLayer，4 按钮（refining 真实纹理 + 3 占位图） |
| 点击按钮 → 鼠标位置出现半透明设备轮廓 | InventoryUI onSelect → placement.enterMode → 预览 Sprite 显示 |
| 移动鼠标 → 预览吸附网格交叉点，一跳一跳 | placement.update 每帧 snapToCell + 预览 Sprite 重定位 |
| 按 R → 预览顺时针旋转 90°，能转满一圈 | screenAngle += 90，sprite.rotation 更新，4 次回 0 |
| 左键点击 → 设备按当前朝向固定在地图上 | onPointerDown(0) → canPlace → 创建实体 + occupy |
| 左键点另一位置 → 第二个设备出现 | 放置后保持 placing 态，连放 |
| 右键或 ESC → 预览消失，退出放置模式 | onPointerDown(2) / onKeyDown(Escape) → exitMode |
| 设备位置在网格交叉点，不偏移 | snapToCell(Math.round) + Position 存吸附坐标 |

---

## 不做（明确排除）

- T1.8 选中（下一会话）
- T1.9 删除（下一会话，但 `releaseFootprint` 接口本会话建好备用）
- 建造成本（A3 §1 后期功能，Phase 1 零代价试错）
- RenderSystem 读 direction 旋转真实体 Sprite（Phase 2 接 §2.4 动态表现时做）
- 缺失 SVG 设备的正式美术（占位图代替，补 SVG 是独立的 T1.3 收尾任务）

---

## 执行顺序

1. 建 `data/buildings.ts` + `components/BuildingComp.ts`（数据层，无依赖）
2. 建 `world/OccupancyMap.ts`（依赖 MapInstance）
3. 写 `scripts/verify-t1.7.ts` 验证 OccupancyMap + R 键换算（TDD：先验逻辑）
4. 建 `systems/PlacementSystem.ts`（依赖 1/2）
5. 重写 `ui/InventoryUI.ts`（依赖 buildings + getTexture）
6. 改 `Game.ts` + `main.ts` 装配
7. 跑 verify 脚本 + tsc + vite build
8. 浏览器实测 8 条验收标准
9. 更新 `doc/implementation-phase-1.md` T1.7 章节加实现备注

每步完成后增量验证，最后整体回归。