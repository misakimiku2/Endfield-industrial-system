# A7 — Core Design Decisions

> **定位**: 项目的"宪法"。所有架构文档、实现代码都必须遵守这些决策。  
> **原则**: 每一条都是一句话判断，要么遵守要么违反，不存在"部分遵守"。  
> **维护**: 新增/修改决策需要审视对已有代码的影响。

> **Phase 归属**: ⚪ **全局**（不分 Phase）。14 条决策贯穿整个项目生命周期，每个 Phase 编码前都应先通读。

---

## DD-001: Entity ID is generation-based, never reused

**决策**: Entity ID 使用递增整数 + 代数标记（generation），销毁后不回收复用。

**理由**: 回收 ID 会导致悬空引用无法检测。generation-based 方案可以安全地判断"这个 ID 指向的实体还活着吗"。

**实现示意**:
```
Entity = { index: number, generation: number }
World.createEntity() → { index: nextIndex++, generation: 0 }
World.destroyEntity(e) → generations[e.index]++ → e 从此无效
```

**反面**: 不能用纯 `number` 做 ID 并依赖 freelist 回收——一旦旧 ID 被新实体复用，所有持有旧引用的系统都会出错。

---

## DD-002: Components are pure data, no methods

**决策**: 所有 ECS Component 必须是纯数据结构（Plain Object / Interface），不包含任何方法、getter/setter 或逻辑。

**理由**: System 拥有全部逻辑，Component 只是 System 的输入/输出。如果 Component 有方法，逻辑会泄漏到数据层，破坏 ECS 的"数据与行为分离"原则。

**正确**: `{ x: number, y: number }`  
**错误**: `{ x: number, get worldX() { ... } }`

---

## DD-003: Buildings are data-driven via Definition

**决策**: 游戏中的每种建筑（熔炉、组装机、采矿机等）不由 Class 定义，而由一个 `BuildingDefinition` 数据对象描述。

**理由**: 新增建筑只需添加一条数据记录，不需要写新类。方便 JSON/编辑器驱动，方便 mod 支持。

**正确**: `world.spawnBuilding('furnace', gridPos)`  
**错误**: `new Furnace(gridPos)`

---

## DD-004: Simulation runs at fixed 20 TPS, independent of 60 FPS render

**决策**: 游戏逻辑（传送带移动、机器生产、敌人 AI）在固定 20 TPS 的时钟上运行。渲染在 60 FPS 的时钟上运行。两个时钟完全独立。

**理由**: 逻辑帧率固定保证确定性（未来可支持 replay / multiplayer）。渲染帧率波动不影响游戏逻辑。

**反面**: 不要把逻辑放在 `requestAnimationFrame` 回调里用 `deltaTime` 缩放——这是动作游戏的做法，不适合工厂模拟。

---

## DD-005: All Definitions never reference Entity IDs

**决策**: `BuildingDefinition`、`ItemDefinition` 等静态数据对象不包含、不引用任何运行时的 Entity ID。

**理由**: Definition 是静态数据，可以被序列化、缓存、跨存档共享。引用 Entity 会将静态数据和运行时状态耦合，导致存档/加载复杂化。

---

## DD-006: Systems communicate ONLY through component changes

**决策**: System A 不允许直接调用 System B 的方法。所有跨系统通信通过读写 Component 完成。

**理由**: 如果 System A 调用 System B 的方法，两个系统产生了编译期耦合，失去 ECS 的最大优势（系统可独立替换）。

**例外**: 工具类（MathHelper、Random 等）不算 System，可以被任意调用。

---

## DD-007: All dynamic visual objects use ObjectPool

**决策**: 所有在游戏运行时会频繁创建/销毁的视觉对象（子弹、粒子、物品掉落、伤害数字）必须通过对象池获取和归还。

**理由**: 避免 GC 抖动导致帧率尖刺。PixiJS Sprite/Graphics 的创建和销毁涉及 GPU 资源，成本远高于 JS 对象。

---

## DD-008: Game art source format (revised)

**决策**: 游戏美术源文件分两类格式，构建时统一打包为纹理图集供 PixiJS 使用：
- **设备 / UI 美术源文件为 SVG**，存储在 `src/assets/svg/`。SVG 可版本控制（diff 友好）、可精确编辑、可脚本化生成，与黑白工业风一致。
- **物品图标为 PNG**（美术已批量出图，254×254 统一规格），存储在 `src/assets/png/`。物品图标数量多（90+）、风格统一，由美术直接产出栅格图，暂不转 SVG。

构建时 `scripts/pack-assets.ts` 用 sharp 把 SVG 光栅化为 PNG，再与已有 PNG 一起按 DD-013 分组打包成 PixiJS spritesheet 图集。

**设备 SVG 分层约定**: 设备 SVG 必须按功能层组织，详见 `doc/asset-drawing-standard.md`。核心要求：
- 画布尺寸 = `footprint.w × 64` × `footprint.h × 64` px
- 可见元素必须放在 `<g id="layer-<name>">` 功能层内（如 `layer-base`、`layer-ports`、`layer-arrows`、`layer-indicators`、`layer-equipment`、`layer-logo`）
- `pack-assets.ts` 会为每个设备输出完整帧 + 各层子帧，供运行时按状态组合渲染

**修订说明**: 原决策（"所有游戏美术源文件为 SVG"）与现状（物品图标为 PNG）冲突。本修订承认既成事实，区分设备/UI（SVG，需可编辑可版本控制）与物品图标（PNG，美术批量出图）。如未来物品图标需要可编辑性，可补 SVG 源文件回归统一格式。

**理由**: SVG 可版本控制（diff 友好）、可精确编辑、可脚本化生成。与黑白工业风美术方向一致。物品图标作为大量、同质化的栅格资产，保留 PNG 避免无意义的矢量转换成本。

---

## DD-009: Coordinate system has three distinct layers

**决策**: 游戏中所有坐标分为三层：Grid（网格坐标，整数）、World（世界像素坐标，浮点）、Screen（屏幕像素坐标，浮点）。层间转换必须通过明确的转换函数。

**理由**: 避免混淆"设备在哪个格子上"和"精灵画在哪个像素上"。每层有自己的语义。

**函数约定**: `gridToWorld()`, `worldToGrid()`, `worldToScreen()`, `screenToWorld()` — 不存在直接从 Grid 到 Screen 的转换。

---

## DD-010: System update order is strictly defined

**决策**: 每个 Simulation Tick 中，系统的执行顺序是固定且不可动态改变的。

**顺序**: BeltSystem → MachineSystem → TurretSystem → EnemySystem → CleanupSystem

**理由**: 顺序影响逻辑正确性。例如 BeltSystem 必须先运行（物品到达机器），MachineSystem 才能检测输入。如果顺序可变，会导致"同一 Tick 内物品是否已到达"的不确定性。

---

## DD-011: All runtime state lives in ECS components

**决策**: 游戏的完整运行时状态（设备位置、物品数量、敌人血量、UI 状态等）必须存储在 ECS Component 中。不使用全局变量、单例状态、或挂在 PixiJS 对象上的自定义属性。

**理由**: 存档 = 序列化所有 Component。如果状态散落在 ECS 之外，存档就会丢数据。

---

## DD-012: Save data is a snapshot of ECS component state

**决策**: 存档格式是"所有实体的所有 Component 数据的快照"，不包含 System 内部状态（如分帧处理的 currentIndex）。

**理由**: 存档读回时 System 可以从 Component 状态完全重建运行上下文。系统内部状态（如遍历进度）可以丢弃并在读档后重新初始化。

---

## DD-013: One texture atlas per logical group

**决策**: 相同类型/相同使用场景的纹理打包到一个图集中。不把所有纹理塞进一张超大图集。

**分组示例**: `devices`（设备）、`enemies`（敌人）、`ui`（界面）、`effects`（粒子效果）、`terrain`（地形）

**理由**: 单张超大图集会超出 GPU 纹理尺寸限制，且无法按场景卸载。分组后可以用 `Assets.unloadBundle()` 按需释放。

---

## DD-014: Frame budget: logic ≤ 5ms, render ≤ 11ms

**决策**: 每帧（16.7ms @ 60FPS）中，游戏逻辑（ECS System update）占用 ≤ 5ms，PixiJS 渲染占用 ≤ 11ms。总计 ≤ 16ms，留 0.7ms 余量。

**理由**: 这是 60FPS 的硬约束。如果逻辑超过 5ms，需要分帧处理或降低 TPS。如果渲染超过 11ms，需要减少 Draw Call 或开启视口裁剪。

---

## DD-015: Atlas textures use mipmaps for minification anti-aliasing

**决策**: 所有 spritesheet 图集（devices/items/ui）的纹理源在加载时开启 mipmap（`autoGenerateMipmaps`+`mipLevelCount`+`scaleMode:'linear'`+各向异性过滤），GPU 上传时自动生成 mipmap 链。配合 `ATLAS_PADDING=8` 抑制子帧在低层级 mipmap 的渗色（bleeding）。

**理由**: PixiJS v8 默认 `autoGenerateMipmaps=false`、`mipLevelCount=1`，纹理在 zoom<1 被缩小时会产生严重 aliasing（精炼炉 logo / 液体接口等高频细节尤其明显，越小越严重）。`antialias:true` 只对几何多边形边缘 MSAA 生效，对纹理采样缩小锯齿无效。mipmap 让 GPU 在缩小时按 LOD 选合适层级采样，aliasing 消除。

**互补关系（重要，避免维护时只改一侧）**:
- **zoom>1（放大）锯齿** → 由 `DEVICE_RASTER_SCALE=4` 光栅化倍率解决（见 DD-008、implementation-phase-1 T1.3）。
- **zoom<1（缩小）锯齿** → 由本决策的 mipmap 解决。
- 两者互补，缺一不可。调高 `CAMERA_ZOOM_MAX` 需同步 `DEVICE_RASTER_SCALE`；关 mipmap 省显存会重新引入缩小锯齿。

**代价**: mipmap 链使图集显存增加约 33%；`ATLAS_PADDING` 从 2 提升到 8 略增图集尺寸。对帧时间几乎无影响（GPU 自动生成、采样近乎免费）。

---

> **这些决策是"不可变"的吗？**  
> 不是。但它们应该只在有充分理由、且已评估影响范围的情况下修改。  
> 每次修改一条决策，需要在 commit message 中引用 DD 编号。
