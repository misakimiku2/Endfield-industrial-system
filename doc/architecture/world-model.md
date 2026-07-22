# A2 — 世界模型

> **关联决策**: DD-009 (三层坐标), DD-011 (状态在 Component)

> **Phase 归属**: 🔵 **Phase 1**（Grid/Cell 概念、OccupancyMap 占用表——设备放置要用） + 🟣 **Phase 4**（Chunk 分帧处理，性能优化时才用）。

---

## 1. 概念层级

从大到小：

```
World         — 游戏世界的根容器，管理所有 Chunk
  └─ Chunk    — 16×16 的 Cell 区块，加载/卸载的最小单元
      └─ Cell  — 网格上的一个位置，有 gridX, gridY 坐标
```

**简称对照**:
- Grid: 网格坐标系（整数坐标）
- Cell: 网格上的一个格子
- Cell Size: 一个格子的世界像素边长 = 64px（默认）
- Chunk: 16×16 个 Cell 组成的矩形区块

---

## 2. Grid / Cell

### 2.1 定义

```ts
// 网格坐标（整数，无单位）
interface GridPos {
  x: number; // gridX — 向右为正
  y: number; // gridY — 向下为正
}

// Cell 大小（世界像素）
const CELL_SIZE = 64;
```

### 2.2 原点

Grid 原点 (0, 0) 在世界的**左上角**。Grid 坐标可以是负数（向西北延伸）。

```
      gridX →
gridY  (0,0)  (1,0)  (2,0)
↓      (0,1)  (1,1)  (2,1)
       (0,2)  (1,2)  (2,2)
```

### 2.3 Cell 与 World 坐标转换

```ts
function cellToWorld(gx: number, gy: number): { x: number; y: number } {
  return { x: gx * CELL_SIZE, y: gy * CELL_SIZE };
}

function worldToCell(wx: number, wy: number): { x: number; y: number } {
  return { x: Math.floor(wx / CELL_SIZE), y: Math.floor(wy / CELL_SIZE) };
}

function snapToCell(wx: number, wy: number): { x: number; y: number } {
  return {
    x: Math.round(wx / CELL_SIZE) * CELL_SIZE,
    y: Math.round(wy / CELL_SIZE) * CELL_SIZE,
  };
}
```

### 2.4 设备放置对齐

设备放置时，世界坐标会自动吸附到最近的 Cell 交叉点：

```
鼠标世界位置 → snapToCell → 设备左上角世界坐标
```

---

## 3. Chunk

### 3.1 定义

```ts
const CHUNK_SIZE = 16; // 16×16 cells per chunk

interface ChunkCoord {
  cx: number; // chunk X 坐标
  cy: number; // chunk Y 坐标
}

function chunkForCell(gx: number, gy: number): ChunkCoord {
  return {
    cx: Math.floor(gx / CHUNK_SIZE),
    cy: Math.floor(gy / CHUNK_SIZE),
  };
}
```

### 3.2 Chunk 的职责

| 职责 | 说明 |
|------|------|
| **地形数据** | 该 Chunk 内每个 Cell 的地形类型（空地/矿脉/不可建造） |
| **占用表** | 该 Chunk 内哪些 Cell 已被建筑占用（用于放置验证） |
| **实体索引** | 该 Chunk 内有哪些 ECS Entity（加速空间查询） |
| **加载/卸载** | 相机视野外的 Chunk 可以卸载地形数据和实体渲染 |

### 3.3 加载策略（Phase 2+ 实现）

- **Phase 1**: 不使用 Chunk 系统。视口内所有实体一次性渲染。世界大小硬限制为 64×64 cells。
- **Phase 2+**: 引入 Chunk 加载/卸载，支持无限世界。

Phase 1 先用伪 Chunk：

```ts
// Phase 1: 简单的占用表（二维数组）
type OccupancyGrid = (string | null)[][]; // null = 空, string = building definitionId
```

---

## 4. 层级模型

世界渲染分为以下层（从底到顶）：

| 层序 | 层名 | 内容 | PixiJS Container |
|------|------|------|------------------|
| 0 | TerrainLayer | 地面瓦片、矿脉标记 | `app.stage.terrainContainer` |
| 1 | GridLayer | 网格线（调试/设计模式） | `app.stage.gridContainer` |
| 2 | BuildingLayer | 已放置的建筑（熔炉、传送带等） | `app.stage.buildingContainer` |
| 3 | ItemLayer | 传送带上的物品、地面掉落物 | `app.stage.itemContainer` |
| 4 | EnemyLayer | 敌人实体 | `app.stage.enemyContainer` |
| 5 | EffectLayer | 子弹、粒子、伤害数字 | `app.stage.effectContainer` |
| 6 | UIOverlay | 选中框、范围指示器 | `app.stage.overlayContainer` |

### 4.1 层规则

- 每层是一个 `Container({ sortableChildren: true })`
- 层内使用 `zIndex` 控制渲染顺序
- **下层不遮挡上层**——这是层级模型的基本保证
- EffectLayer 使用 `ParticleContainer`（DD-007 对象池 + 性能优化）

---

## 5. 视觉风格

### 5.1 基础配色

| 元素 | 颜色值 | 说明 |
|------|--------|------|
| **网格背景** | `#E6E4E4` | 全屏的基底色，覆盖整个 Canvas |
| **网格线条** | `#D6D4D4` | 64px 间距的网格线，略深于背景 |
| **屏幕暗角** | `rgba(0,0,0,0.3)` 径向渐变至透明 | 四角叠加的暗角效果 |

### 5.2 网格线条

- 间距固定 64px（对应 CELL_SIZE），与 Cell 对齐
- 线条使用 `#D6D4D4` 纯色，宽度 1px
- 在屏幕**四个边缘**，网格线条透明度从中心到边缘渐变为 0（即边缘不可见），使用 Canvas 径向渐变蒙版或独立 Graphics 透明度插值实现

```
透明度分布示意（俯视图）：
+---------------------------------------+
|   完全透明 -> 逐渐显示 -> 完全显示     |
|  +---------------------------------+  |
|  | 区域内网格线完全不透明            |  |
|  |                                 |  |
|  +---------------------------------+  |
|   完全显示 <- 逐渐透明 <- 完全透明     |
+---------------------------------------+
```

- 网格线渲染在 GridLayer（层序 1），位于背景之上、建筑之下

### 5.3 屏幕暗角（Vignette）

- 在屏幕最顶层（UIOverlay 之上）叠加一个全屏径向渐变层
- 四角使用 `rgba(0, 0, 0, 0.3)` 向中心渐变为完全透明
- 暗角跟随视口大小动态调整（CSS 或 Canvas 实现均可）
- 暗角仅影响视觉效果，不阻挡鼠标交互（`pointer-events: none`）

```ts
// 暗角实现示意（CSS）
const vignetteStyle = {
  position: 'fixed' as const,
  inset: 0,
  pointerEvents: 'none' as const,
  background: 'radial-gradient(ellipse 80% 80% at 50% 50%, transparent 50%, rgba(0,0,0,0.3) 100%)',
};
```

### 5.4 渲染顺序（叠加效果）

从底到顶的最终渲染效果：

```
1. 网格背景色 (#E6E4E4)        <- 整个 Canvas 底色
2. 网格线条 (#D6D4D4, 边缘渐隐)  <- GridLayer
3. 建筑/设备/物品/实体         <- BuildingLayer / ItemLayer / EnemyLayer
4. 选中框/UI                   <- UIOverlay
5. 四角暗角 (径向渐变)          <- 最顶层叠加
```

---

## 6. 地形

### 6.1 Phase 1 地形

Phase 1 只有一种地形：**平地**。所有 Cell 默认可建造。

```ts
enum TerrainType {
  GROUND = 'ground',      // 平地，可建造
  ORE_PATCH = 'ore_patch', // 矿脉，采矿机专用
  BLOCKED = 'blocked',     // 不可建造（未来用于障碍物/悬崖）
}
```

### 6.2 矿脉

矿脉是一个 Cell 的属性，不是独立的 Entity。采矿机放置在矿脉上才能工作（Phase 3+ 实现，跟随地形系统）。

---

## 7. 占用表

### 7.1 用途

放置设备前检查目标 Cell 是否已被占用：

```ts
// Phase 1 简单实现
class OccupancyMap {
  private grid: Map<string, string> = new Map(); // key: "gx,gy" → definitionId

  occupy(gx: number, gy: number, defId: string): void;
  isOccupied(gx: number, gy: number): boolean;
  getOccupant(gx: number, gy: number): string | null;
  release(gx: number, gy: number): void;

  // 检查一个 footprint 区域是否全部空闲
  canPlace(gx: number, gy: number, w: number, h: number): boolean;
}
```

### 7.2 多 Cell 建筑

占地面 >1×1 的建筑（如组装机 2×2）会占用多个 Cell。`canPlace` 检查 footprint 内所有 Cell。

---

## 8. 世界边界

Phase 1 设定世界大小为 **64×64 cells**（4096 个 Cell，约 1 万像素见方）。

这个范围足够放置 100+ 设备 + 传送带网络。超出边界不可放置、不可平移。

```ts
const WORLD_WIDTH_CELLS = 64;
const WORLD_HEIGHT_CELLS = 64;
```
