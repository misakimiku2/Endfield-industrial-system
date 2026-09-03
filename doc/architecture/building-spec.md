# A3 — 建筑规范

> **关联决策**: DD-003 (数据驱动), DD-005 (Definition 不引用 Entity), DD-011 (状态在 Component)

> **Phase 归属**: 🔵 **Phase 1**（§1 BuildingDefinition、§2 Port 系统、§3.4 占地、§5 建造流程——设备放置要用） + 🟢 **Phase 2**（§3 BuildingComponent 缓冲区/生产计时、§4 状态机——生产逻辑要用）。Phase 1 先实现 Definition/Port/放置，Phase 2 再接 Component 缓冲区。

---

## 1. BuildingDefinition

所有建筑类型由数据定义，存放在 `src/data/buildings.ts`：

```ts
interface BuildingDefinition {
  id: string;                    // 唯一标识: "refining_unit", "shredding_unit"
  name: string;                  // 显示名称: "精炼炉"
  category: BuildingCategory;    // 分类
  footprint: { w: number; h: number };  // 占地面 (单位: Cell)
  ports: Port[];                 // 输入/输出口
  texture: string;               // 主体纹理图集 key
  logoTextureKey?: string;       // 可选：billboard 徽标层 key，运行时叠加并保持屏幕朝上
  selectable: boolean;           // 是否可被玩家选中
  buildCost: CostEntry[];        // 建造成本
  powerConsumption: number;      // 耗电峰值 (单位: W)
  inputSlotCount: number;        // 固体输入槽位数（每槽锁一种物品，见 §3.1）
  outputSlotCount: number;       // 固体输出槽位数（一槽一物，与输入对称）
  bufferCapacity: number;        // 每个槽位的容量上限，默认 50
}

type BuildingCategory = 'extraction'  // 采矿类
                      | 'production'  // 生产类（精炼炉、粉碎机）
                      | 'logistics'   // 物流类（传送带、分流器）
                      | 'defense'     // 防御类（炮塔）
                      | 'agriculture'; // 农业类（种植机、采种机）

interface CostEntry {
  itemId: string;
  count: number;
}
```

> **关于 buildCost 的 itemId**：下方设备定义中 `buildCost` 引用的 `stone`（石头）、`iron_plate`（铁板）是**占位 itemId**，这两个物品目前未在 A4 §1.1 定义。建造成本扣除是后期功能（Phase 1/2 不实现成本约束），待 `items.csv` 物品总表建立后，用真实物品的 itemId 替换这些占位值。

### 1.1 首批设备定义

```ts
const BUILDING_DEFINITIONS: Record<string, BuildingDefinition> = {
  refining_unit: {
    id: 'refining_unit',
    name: '精炼炉',
    category: 'production',
    footprint: { w: 3, h: 3 },
    ports: [
      // 底部一排：输入端口
      { type: 'input',  position: { dx: 0, dy: 2 } },
      { type: 'input',  position: { dx: 1, dy: 2 } },
      { type: 'input',  position: { dx: 2, dy: 2 } },
      // 顶部一排：输出端口
      { type: 'output', position: { dx: 0, dy: 0 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
      // 中间层：液体端口（Phase 2+ 实现）
      { type: 'liquid', position: { dx: 0, dy: 1 } },
      { type: 'liquid', position: { dx: 2, dy: 1 } },
    ],
    texture: 'refining_unit',
    logoTextureKey: 'refining_unit/logo',
    selectable: true,
    buildCost: [{ itemId: 'stone', count: 5 }],
    powerConsumption: 5,
    inputSlotCount: 1,            // 固体原料槽（赤铜矿等）；赤铜块配方的清水走 liquid 端口(Phase 2)
    outputSlotCount: 1,           // 固体产物槽（赤铜块等）；赤铜块的污水走 liquid 端口(Phase 2)
    bufferCapacity: 50,
  },

  shredding_unit: {
    id: 'shredding_unit',
    name: '粉碎机',
    category: 'production',
    footprint: { w: 3, h: 3 },
    ports: [
      { type: 'input',  position: { dx: 0, dy: 2 } },
      { type: 'input',  position: { dx: 1, dy: 2 } },
      { type: 'input',  position: { dx: 2, dy: 2 } },
      { type: 'output', position: { dx: 0, dy: 0 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
    ],
    texture: 'shredding_unit',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 8 }],
    powerConsumption: 5,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },

  fitting_unit: {
    id: 'fitting_unit',
    name: '配件机',
    category: 'production',
    footprint: { w: 3, h: 3 },
    ports: [
      { type: 'input',  position: { dx: 0, dy: 2 } },
      { type: 'input',  position: { dx: 1, dy: 2 } },
      { type: 'input',  position: { dx: 2, dy: 2 } },
      { type: 'output', position: { dx: 0, dy: 0 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
    ],
    texture: 'fitting_unit',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 12 }],
    powerConsumption: 20,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },

  moulding_unit: {
    id: 'moulding_unit',
    name: '塑形机',
    category: 'production',
    footprint: { w: 3, h: 3 },
    ports: [
      { type: 'input',  position: { dx: 0, dy: 2 } },
      { type: 'input',  position: { dx: 1, dy: 2 } },
      { type: 'input',  position: { dx: 2, dy: 2 } },
      { type: 'output', position: { dx: 0, dy: 0 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
    ],
    texture: 'moulding_unit',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 10 }],
    powerConsumption: 10,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },

  seed_picking_unit: {
    id: 'seed_picking_unit',
    name: '采种机',
    category: 'agriculture',
    footprint: { w: 5, h: 5 },
    ports: [
      // 底部一行：输入端口
      { type: 'input',  position: { dx: 1, dy: 4 } },
      { type: 'input',  position: { dx: 2, dy: 4 } },
      { type: 'input',  position: { dx: 3, dy: 4 } },
      // 顶部一行：输出端口
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
      { type: 'output', position: { dx: 3, dy: 0 } },
    ],
    texture: 'seed_picking_unit',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 15 }],
    powerConsumption: 10,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },

  planting_unit: {
    id: 'planting_unit',
    name: '种植机',
    category: 'agriculture',
    footprint: { w: 5, h: 5 },
    ports: [
      { type: 'input',  position: { dx: 1, dy: 4 } },
      { type: 'input',  position: { dx: 2, dy: 4 } },
      { type: 'input',  position: { dx: 3, dy: 4 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
      { type: 'output', position: { dx: 3, dy: 0 } },
    ],
    texture: 'planting_unit',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 15 }],
    powerConsumption: 20,
    inputSlotCount: 1,            // 种子槽；锦草/芽针配方的清水走 liquid 端口(Phase 2)
    outputSlotCount: 1,
    bufferCapacity: 50,
  },
};
```

---

## 2. Port 系统

### 2.1 定义

```ts
interface Port {
  type: 'input' | 'output' | 'liquid';          // liquid 端口（Phase 2+ 实现）
  position: { dx: number; dy: number };          // 相对建筑左上角的 Grid 坐标偏移 (单位: Cell)
  itemFilter?: string[];                         // 可选: 物品白名单（按 category 或 itemId）
}
```

**坐标系说明**：
- `position.dx` / `position.dy` 是相对于建筑左上角（`footprint` 的西北角）所在的 Grid 单元格的偏移量。
- 例如 3×3 建筑，左上角为 `(gx, gy)`，则 `position: { dx: 0, dy: 2 }` 对应的世界 Grid 坐标为 `(gx + 0, gy + 2)`。
- Port 位置不随方向改变而改变其定义值，方向仅影响运行时 Port 的世界坐标计算（见 2.2 节）。

### 2.2 方向旋转

建筑有 4 个方向（0°=右, 90°=下, 180°=左, 270°=上；**90° = 顺时针**，与 Sprite 渲染旋转一致）。Port 的 `position` 是默认方向（0°）下的值。旋转时 Port 位置跟随旋转：

> **[2026-09-04 T2.17 修订]** 占地约定由"旋转后占地不变"改为：**90°/270° 旋转时占地宽高互换**（w×h → h×w，同 Factorio 惯例；0°/180° 不变）。非正方形设备（3×1 仓库口）由此解锁四向旋转。单一事实源：`buildings.ts effectiveFootprint(footprint, direction)`。下述公式已按顺时针约定修正（旧版 90°/270° 两式标反，与代码实现不符）。

旋转算法（以 footprint 左上角为原点；90°/270° 代入**互换后**的占地 h×w）：
- 0°: `(dx, dy)` 不变（占地 w×h 不变）
- 90°（顺时针）: `(dx, dy)` → `(footprint.h - 1 - dy, dx)`（占地变为 h×w，顶边端口转到右边）
- 180°: `(dx, dy)` → `(footprint.w - 1 - dx, footprint.h - 1 - dy)`（占地不变）
- 270°（逆时针）: `(dx, dy)` → `(dy, footprint.w - 1 - dx)`（占地变为 h×w，顶边端口转到左边）

实现: `PortGeometry.rotatePort`（对正方形占地与旧"绕中心旋转"数学逐点等价，正方形设备零行为变化）。

### 2.3 传送带连接

传送带没有显式的 Port——它的输入/输出由**方向**和**相邻传送带/建筑**隐式决定：

- 传送带 A (方向→右) 的右侧 Cell 有传送带 B (方向→右) → 物品从 A 流向 B
- 传送带 A (方向→右) 的右侧 Cell 有建筑输入端口 → 物品从 A 进入建筑 Input Port
- 建筑 Output Port 所在 Cell 有传送带 → 物品从建筑进入传送带

### 2.4 端口与设备的动态视觉表现

> **Phase 归属**: 🟢 **Phase 2**（设备有状态机/缓冲区后才需要动态表现；Phase 1 设备是静态贴图）。
> **关联**: T1.6 渲染系统（`RenderSystem`，单 Sprite 模型）、§4 状态机（驱动状态表现）。

设备运行时会有多种动态视觉需求（端口变色、元素位移、形状变形等）。这些**不属于纹理质量问题**（T1.3 的 4× 光栅化已解决静态清晰度），而是"运行时根据游戏状态改变局部视觉"。

#### 决策：按"离散状态 vs 连续运动"分三种实现路径

| 效果类型 | 实现路径 | 适用场景 | 代价 |
|---------|---------|---------|------|
| **端口变色 / 开关状态**（局部或整体颜色变化） | **多帧切换**（`AnimatedSprite`）或 **ColorMatrixFilter** 着色 | 离散有限状态（未连接/已连接/激活/堵塞） | 状态数 × 帧数的纹理增量；状态少时极省 |
| **形状变形**（圆形→方形等几何变化） | **多帧切换**（预渲染变形序列帧） | 离散或缓动变形，形状复杂 | 帧数随变形平滑度增长 |
| **元素位移 / 流动指示**（图标内某部件平移、传送带流动箭头） | **Graphics 矢量重绘** 或 **子 Sprite 独立 position** | 连续运动，形状简单 | 逐帧重绘/移动，但性能好；复杂图形手绘成本高 |

**判断标准**：效果是"有限离散状态"→ 多帧切换；是"连续运动"→ Graphics/独立对象。纯颜色变换（不改形状）可用滤镜（GPU 着色，性能好）。

#### 推荐架构：设备视图分层

不要把整个设备做成一张大纹理序列（纹理爆炸）。设备作为**组合视图**：

```
设备 = 一个 Container（BuildingView）
  ├─ 主体 Sprite       （layer-base，静态高分辨率纹理）
  ├─ 端口 Sprite       （layer-ports，动态：变色/隐藏）
  ├─ 箭头 Sprite       （layer-arrows，方向指示）
  └─ 指示符 Graphics   （layer-indicators / layer-state-*，动态状态）
```

这样：主体保持高分辨率静态纹理（清晰、省内存），只有真正动的部件是动态对象，复合效果（主体静止 + 端口变色 + 指示符流动）可叠加。

> **T1.7 已提前落地**: 设备 SVG 已按 `layer-*` 功能层规范化（`layer-base` / `layer-ports` / `layer-arrows` / `layer-indicators` / `layer-equipment` / `layer-logo`），`scripts/pack-assets.ts` 会为每个设备输出完整帧 + 各层子帧（`<device_key>/base`、`/ports`、`/arrows`、`/indicators`、`/equipment`、`/logo`），详见 `doc/asset-drawing-standard.md`。Phase 2 组合渲染时无需再改美术源文件。

#### 对 T1.6 渲染系统的影响（Phase 2 扩展点）

Phase 1 的 `RenderSystem` 以"一个实体 = 一个 Sprite"为主（`SpriteComp` 单纹理单层），当前使用完整设备帧（如 `refining_unit`）。特例是 T1.7 为精炼炉增加的 billboard 徽标层：带 `logoTextureKey` 的建筑会额外叠加一个反向旋转的 `layer-logo` 子 Sprite，保持屏幕朝上。Phase 2 接生产逻辑、设备有状态机/缓冲区需要表现时，再扩展为"设备 = 多部件 Container"：

- 对带 `BuildingComp` 的实体创建 `BuildingView` Container，叠加 `layer-base` / `layer-ports` / `layer-arrows` / `layer-indicators` / `layer-equipment` / `layer-logo` Sprite
- 状态变化时只切换/染色/隐藏对应层 Sprite，避免重绘整个设备
- 普通实体（传送带、敌人等）仍走单 Sprite 路径
- 动态部件的状态来源：`BuildingComponent` 的状态机（§4）+ Port 连接状态（§2.3）

**Phase 1 仅做素材层准备**——设备仍用单 Sprite 静态贴图。此节作为 Phase 2 开发时的设计参考，避免届时重新讨论实现路径。

#### PixiJS v8 可用 API（已确认本项目依赖支持）

- `AnimatedSprite` — 多帧切换（状态变色、变形序列）
- `Graphics` — 矢量运行时绘制（位移、简单变形）
- `ColorMatrixFilter` / `Filter` — GPU 着色（选中高亮、激活闪烁）
- `Ticker` — 逐帧驱动连续动画
- `DisplacementFilter` — 位移变形（高级，按需）

---

## 3. BuildingComponent（ECS）

> **实现进度注（2026-08-17 对照 `src/game/components/BuildingComp.ts`）**: 代码中 `state` 类型目前为
> `'idle' | 'working' | 'blocked'`（`no_power` Phase 3+）；`inputPollIndex`/`outputPollIndex` 轮询指针
> 按任务进度**延后至 T2.10 加入**（避免引入未使用字段，当前按端口定义序遍历、行为等价）；
> `paused`（玩家手动暂停）T2.8 加入。其余字段（BufferSlot/currentRecipeId/progress/elapsed/
> bufferInput/bufferOutput）已按本节实现（T2.4/T2.5）。

```ts
// 单个缓冲区槽位。每槽只容纳一种物品；itemId === null 表示该槽为空、未锁定。
interface BufferSlot {
  itemId: string | null;
  count: number;              // 槽内该物品的数量，0 ~ bufferCapacity
}

interface BuildingComponent {
  definitionId: string;               // 对应 BuildingDefinition.id
  direction: 0 | 90 | 180 | 270;      // 朝向
  state: BuildingState;               // 当前状态

  // === 生产计时（原"加工位"概念已删除，字段直接并入 Component）===
  currentRecipeId: string | null;     // 当前正在生产的配方 id；null = 空闲，无生产任务
  progress: number;                   // 生产进度 0~1
  elapsed: number;                    // 已消耗时间 (ms)

  // === 缓冲区（每槽一种物品，数组长度由 BuildingDefinition 的槽位数决定）===
  bufferInput:  BufferSlot[];         // 固体输入槽，长度 = BuildingDefinition.inputSlotCount
  bufferOutput: BufferSlot[];         // 固体输出槽，长度 = BuildingDefinition.outputSlotCount
  // 每个槽的容量上限统一取自 BuildingDefinition.bufferCapacity（默认 50），无需逐槽存储

  // === 轮询指针 ===
  inputPollIndex: number;             // 输入轮询指针，指向下一个要轮询的输入端口索引
  outputPollIndex: number;            // 输出轮询指针，指向下一个要轮询的输出端口索引
  // 注意：不再有 lockedInputType 字段。输入槽的"锁定"信息内含在每个槽的 itemId（非 null 即锁定该类型）。
}

type BuildingState = 'idle' | 'working' | 'blocked' | 'no_power';
```

**关于生产模型**：生产期间**原料始终停留在输入槽中，不会被扣除**；只有当生产计时走完那一刻，才发生一次原子结算——同时扣除输入槽的原料、向输出槽加入产物。详见 A8 §3 生产计时系统。

**关于槽位数量**：`bufferInput`/`bufferOutput` 的数组长度由 `BuildingDefinition.inputSlotCount`/`outputSlotCount` 决定，不同设备槽位数不同（精炼炉 1进1出，研磨机 2进1出，等）。槽位数 = 该设备配方所需固体原料/产物的最大种类数。液体（清水、污水等）走专用 `liquid` 端口，**不占物品槽**（液体系统 Phase 2+ 实现）。

### 3.1 缓冲区规则

设备有 N 个输入槽 + M 个输出槽（数量见 `BuildingDefinition`）。每个槽独立运作，互不干扰：

- **输入槽**用于存放等待生产的原料。每个槽独立锁定一种物品类型：
  - 槽为空（`itemId === null`）时处于"未锁定"状态，下一件进入的物品决定该槽的类型（`itemId` 设为该物品）。
  - 槽非空时锁定该类型，只允许相同类型的物品继续进入；不同类型的物品无法进入此槽，停留在传送带上等待（可尝试进入其他空输入槽）。
  - 当槽内数量降为 0 时，`itemId` 立即置为 `null` 解除锁定，下一件物品重新决定类型。
- **输出槽**用于存放已完成生产的产物，一槽一种物品。产物类型由配方决定，通过输出端口送往传送带。
- **生产期间不扣输入**：原料在生产计时走完前始终留在输入槽中。计时完成时才发生原子结算（扣输入 + 加输出），详见 A8 §3。
- 所有槽的容量上限统一为 `BuildingDefinition.bufferCapacity`（默认 50）。

### 3.2 轮询规则

**输入轮询**：
- 输入端口按索引顺序 `0 → 1 → 2 → ... → n-1 → 0 → 1 → ...` 循环轮询。
- 当轮询到某端口时，检查该端口是否有物品等待传入，并寻找一个可接受该物品的输入槽（槽为空可成为新锁定类型，或槽已锁定同类型且未满）。
- 若找到可接受的槽，则传入 1 个物品到该槽（槽空时设 `itemId`），轮询指针移动到下一个索引。
- 若无可接受槽（所有槽都锁定了其他类型、或同类型槽已满、或端口无物品），则指针立即移动到下一个索引继续尝试。
- 轮询指针不会因设备满载而重置，始终保持当前位置。

**输出轮询**：
- 输出端口按索引顺序 `0 → 1 → 2 → ... → n-1 → 0 → 1 → ...` 循环轮询。
- 当前端口连接的传送带可写入时，从输出缓冲区取出 1 个物品发出。
- 若当前端口堵塞（传送带不可写入），则跳过该端口，指针移动到下一个索引。
- 堵塞端口恢复可写时，**追加**到当前轮询顺序的末尾（不插回原位），确保不会饿死其他端口。

> **实现注（2026-08-25，T2.10）**: 输出轮询落地为 `BuildingComp.outputPollQueue`
> （活跃端口按轮询序的显式队列）而非单一 `outputPollIndex` 指针——"堵塞移出/恢复
> 追加队尾"语义（A8 §4.2）需要显式队列表达；**堵塞集 = 全部输出端口 − 队列**
> （派生值不落盘，DD-012 存档只存队列）。输入侧仍为 `inputPollIndex` 指针
> （满载冻结不重置）。详见 implementation-phase-2.md T2.10 实现笔记。

### 3.3 方向约定

```
0°   = 朝右 (→)
90°  = 朝下 (↓)
180° = 朝左 (←)
270° = 朝上 (↑)
```

出口默认在建筑前方（0° 的右方）。入口默认在建筑后方。

> **存储 vs 玩家输入的参考系差异**：`BuildingComponent.direction` 的上述值是**世界相对**存储的（存档/模拟都用世界朝向）。但**玩家按 R 键旋转**时的手感是**相对视图**的（屏幕上看起来转 90°）。当视图旋转 `viewRotation ≠ 0` 时（见 A6 §4.0），换算关系为 **世界朝向 = 屏幕朝向 − viewRotation (mod 360)**。即视图转 90° 后按一次 R，屏幕朝向 +90° 而世界朝向不变；连按两次才让世界朝向真正 +90°。实现放置/移动旋转时务必走此换算，不要直接对 `direction` 加 90。

### 3.4 Footprint 与 Cell 占用

```ts
// 建筑放置在 (gx, gy)，占 footprint.w × footprint.h 个 Cell
// (gx, gy) 是建筑左上角 Cell

function getOccupiedCells(gx: number, gy: number, w: number, h: number): GridPos[] {
  const cells: GridPos[] = [];
  for (let dx = 0; dx < w; dx++) {
    for (let dy = 0; dy < h; dy++) {
      cells.push({ x: gx + dx, y: gy + dy });
    }
  }
  return cells;
}

// 世界像素位置（设备 Sprite 的锚点位置）
function getWorldOrigin(gx: number, gy: number): { x: number; y: number } {
  return {
    x: gx * CELL_SIZE,
    y: gy * CELL_SIZE,
  };
}
```

---

## 4. 状态机

> **扩展（2026-08-17 已定案，T2.8 实现）**: 新增玩家手动暂停 `paused`——正交于 idle/working/blocked
> 的布尔开关（非第 4 个互斥态），设备弹窗"开/关"电源开关控制；暂停时计时冻结（不归零）、不吸入
> 不输出，恢复续走。状态**外部视觉**为终末地风格 LOGO 图标方案（正常=LOGO / 暂停=深灰图标 /
> 堵塞=红 X）+ 端口连接高亮（黄 #FFEF00 / 堵塞红），替代"状态文字"方案。详见
> implementation-phase-2.md T2.8 与 A8 §6 扩展注。

### 4.1 状态转换图

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    v                                     │
    ┌─────────┐  开始生产  ┌──────────┐  完成生产  ┌─────────┐
    │  idle   │ ────────→ │ working  │ ────────→ │  idle   │
    └────┬────┘           └────┬─────┘           └────▲────┘
         │                     │                       │
         │ 输出已满            │ 输出已满              │ 输出有空间
         v                     v                       │
    ┌─────────┐           ┌──────────┐                 │
    │ blocked │ ←──────── │ blocked  │ ────────────────┘
    └────┬────┘  (生产完成  └──────────┘
         │       但无法放入
         │       输出缓冲区)
         │
         │ 输出有空间
         v
    ┌─────────┐
    │ idle/idle│
    └─────────┘

    ┌──────────────────────────────────────────────┐
    │              no_power (Phase 3+)              │
    │  idle/working/blocked ──── 断电 ────→ no_power│
    │  no_power ──── 恢复供电 ────→ idle           │
    └──────────────────────────────────────────────┘
```

### 4.2 状态说明

| 状态 | 说明 |
|------|------|
| `idle` | 设备空闲，等待原料进入输入槽。输入槽可能为空或有原料但未满足配方条件，无生产计时 |
| `working` | 设备正在生产。原料**仍停留在输入槽中**（未被扣除），生产计时 `progress` 从 0 向 1 增长。计时完成后才扣输入、加输出 |
| `blocked` | 设备阻塞。输出槽已满，无法放入新的产物。此时若计时完成，结算无法完成，原料也不会被扣除，停留在输入槽中 |
| `no_power` | 设备断电。所有生产活动停止（Phase 3+ 实现，详见 A10）|

### 4.3 转换条件

| 当前状态 | 下一状态 | 条件 |
|----------|----------|------|
| `idle` | `working` | 输入槽有足够原料满足某配方，且当前无生产计时 → 启动计时（不扣原料） |
| `idle` | `blocked` | 输出槽已满，且输入槽有原料但无法产出（输出无空间） |
| `working` | `idle` | 生产计时完成，原子结算成功（扣输入 + 加输出），且无其他可匹配配方 |
| `working` | `blocked` | 生产计时完成，但输出槽已满，结算无法完成 |
| `blocked` | `idle` | 输出槽腾出空间，结算完成（扣输入 + 加输出），且输入槽不满足任何配方 |
| `blocked` | `working` | 输出槽腾出空间，结算完成，且输入槽仍满足配方 → 启动下一次计时 |
| 任意 | `no_power` | 电力系统判定断电 (Phase 3+) |
| `no_power` | `idle` | 电力恢复 (Phase 3+) |

---

## 5. 建造流程

```
1. 玩家在工具栏选择建筑定义
2. 鼠标移动 → 屏幕坐标转世界坐标 → snapToCell → 显示半透明预览
3. 左键点击 → 检查 canPlace(footprint)
   3a. 失败 → 预览变红 + 震动反馈
   3b. 成功 →
     - 创建 Entity
     - 添加 BuildingComponent({
         definitionId,
         direction,
         state: 'idle',
         currentRecipeId: null,
         progress: 0,
         elapsed: 0,
         bufferInput:  Array(definition.inputSlotCount).fill({ itemId: null, count: 0 }),   // N 个空输入槽
         bufferOutput: Array(definition.outputSlotCount).fill({ itemId: null, count: 0 }),  // M 个空输出槽
         inputPollIndex: 0,
         outputPollIndex: 0,
       })
     - 添加 Position(snapToCell 结果)
     - 添加 SpriteComp({ texture, ... })
     - OccupancyMap.occupy(footprint cells)
     - RenderSystem 自动创建 Sprite
```

---

## 6. 规则

| 规则 | 说明 |
|------|------|
| **Definition 是只读的** | `BuildingDefinition` 在运行时不可修改 |
| **不要为每个建筑创建 Class** | `BuildingComponent` + `BuildingDefinition` 的组合足以描述所有建筑 |
| **Footprint 以 Cell 为单位** | w/h 是整数，1×1, 1×2, 2×2, 3×3, 5×5... |
| **方向只影响渲染和 Port** | `BuildingComponent.direction` 改变 Sprite 旋转角度和 Port 世界坐标；占地是否互换见下条 |
| **90°/270° 旋转占地宽高互换**（T2.17 修订） | 正方形占地旋转不变（3×3 旋转后仍是 3×3）；非正方形占地 90°/270° 旋转时 w×h → h×w（3×1 ↔ 1×3），见 `effectiveFootprint`。占用检查/端口几何/渲染锚点均按**有效占地**计算 |
| **Port 位置使用 Grid 坐标** | `Port.position.dx/dy` 是相对建筑左上角的 Grid 偏移，非建筑中心偏移 |
| **输入锁定机制** | 每个输入槽独立锁定一种物品类型，槽内数量降为 0 时解除该槽的锁定 |
| **轮询指针不重置** | 无论设备状态如何，轮询指针始终保持在当前位置，不因满载/阻塞而回零 |
| **堵塞端口追加队尾** | 输出端口恢复可写时追加到轮询顺序末尾，不插回原位 |
