# A6 — 坐标规范

> **关联决策**: DD-009 (三层坐标)

> **Phase 归属**: 🔵 **Phase 1**（Grid↔World↔Screen 三层坐标转换、Camera——相机系统和设备放置的核心依赖，Phase 1 全部实现）。

---

## 1. 三层坐标系

```
Grid Space (格子坐标)          World Space (世界像素坐标)        Screen Space (屏幕像素坐标)
─────────────────────          ─────────────────────────         ──────────────────────────
单位: Cell                     单位: px                          单位: px
类型: 整数                     类型: 浮点                        类型: 浮点
原点: 世界左上角 (0,0)         原点: 同 Grid                     原点: Canvas 左上角
范围: 可负、可正               范围: 可负、可正                  范围: 0 ~ canvas.width/height

   gridX →                       worldX →                         screenX →
gridY   +---+---+              +0---+64--+128-+               +0---+---+---+
↓       |0,0|1,0|            y |   |   |   |                 |   |   |   |
        +---+---+               +64-+---+---+                 +---+---+---+
        |0,1|1,1|               +128-+---+---+                 +---+---+---+
        +---+---+
```

---

## 2. 转换函数

```ts
const CELL_SIZE = 64;

// === Grid ↔ World ===

function gridToWorld(gx: number, gy: number): { x: number; y: number } {
  return { x: gx * CELL_SIZE, y: gy * CELL_SIZE };
}

function worldToGrid(wx: number, wy: number): { x: number; y: number } {
  return { x: Math.floor(wx / CELL_SIZE), y: Math.floor(wy / CELL_SIZE) };
}

function snapToGrid(wx: number, wy: number): { x: number; y: number } {
  return {
    x: Math.round(wx / CELL_SIZE) * CELL_SIZE,
    y: Math.round(wy / CELL_SIZE) * CELL_SIZE,
  };
}

// === World ↔ Screen ===
// 由 Camera 类管理，使用矩阵变换

// === Grid → Screen ===
// 不存在直接的 Grid → Screen 转换。
// 正确路径: Grid → World → Camera.matrix → Screen
```

### 2.1 像素对齐

为了避免亚像素渲染模糊，World → Screen 转换后对 Sprite 位置做像素对齐：

```ts
function pixelAlign(value: number): number {
  return Math.round(value);
}

// 在 RenderSystem 中
const screenPos = camera.worldToScreen(worldX, worldY);
sprite.x = pixelAlign(screenPos.x);
sprite.y = pixelAlign(screenPos.y);
```

---

## 3. 网格吸附

设备放置时自动吸附：

```ts
function snapPlacement(worldX: number, worldY: number): { x: number; y: number } {
  // 吸附到最近的 Cell 左上角
  return {
    x: Math.round(worldX / CELL_SIZE) * CELL_SIZE,
    y: Math.round(worldY / CELL_SIZE) * CELL_SIZE,
  };
}
```

对于 1×1 设备，吸附后的世界坐标就是该 Cell 的左上角。
对于 2×2 设备，吸附后的世界坐标是 footprint 左上角 Cell 的左上角。

---

## 4. Camera

```ts
class Camera {
  x: number;       // 相机中心的世界 X 坐标
  y: number;       // 相机中心的世界 Y 坐标
  zoom: number;    // 缩放倍率 (1.0 = 1 世界像素 = 1 屏幕像素)
  viewRotation: 0 | 90 | 180 | 270;  // 视图旋转角度（T1.5 引入），0 = 默认朝向

  // 世界坐标 → 屏幕坐标
  // 复合变换：world → 相对相机中心 → 绕中心旋转 viewRotation → × zoom → + 屏幕中心
  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const dx = wx - this.x;
    const dy = wy - this.y;
    const rad = -this.viewRotation * Math.PI / 180;  // 视图顺时针转 = 内容逆时针变到屏幕
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    return {
      x: rx * this.zoom + canvasWidth / 2,
      y: ry * this.zoom + canvasHeight / 2,
    };
  }

  // 屏幕坐标 → 世界坐标（worldToScreen 的逆运算）
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const dx = (sx - canvasWidth / 2) / this.zoom;
    const dy = (sy - canvasHeight / 2) / this.zoom;
    const rad = this.viewRotation * Math.PI / 180;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    return { x: rx + this.x, y: ry + this.y };
  }
}
```

### 4.0 viewRotation 与参考系（T1.5 引入）

视图旋转是**渲染/输入层**概念，改变的是世界如何在屏幕上呈现，**不改变世界本身**。

**参考系约定**：
- **平移操作（WASD / 边缘滚动）→ 屏幕相对**：玩家按 W 永远让画面向屏幕上方移动。实现上，屏幕"上"方向在世界坐标系中旋转了 viewRotation 度，平移量要按此映射回相机世界坐标增量。例如视图转 90° 时按 W（屏幕上），相机世界 Y 实际减小。
- **设备旋转 R 键 → 相对视图**：玩家按 R 让设备在屏幕上看起来转 90°。A3 §3.3 的 `BuildingComponent.direction` 是世界相对存储，换算关系：**世界朝向 = 屏幕朝向 − viewRotation**（mod 360）。即视图转 90° 后按 R，屏幕朝向 +90°，世界朝向实际不变（90 − 90 = 0）；连按两次才让世界朝向真正 +90°。
- **滚轮缩放**：不受 viewRotation 影响，仍以鼠标位置为锚点。

**边界 clamp**：viewRotation 不改变相机可看的世界范围（64×64 cells），只改变呈现方式。`x/y` 的 clamp 边界仍是 T1.2 定义的世界范围。

> **实现提醒**：`updateTransform` 写入 `worldContainer` 时，要把 viewRotation 反映到 PixiJS Container 的 rotation（配合 pivot 处理枢轴 = 屏幕中心对应的相机中心）。模拟层（Phase 2 的传送带/机器）完全不感知 viewRotation，不要把旋转信息存进任何 Component。

### 4.1 相机约束

```ts
// Phase 1 约束
this.x = clamp(this.x, minWorldX, maxWorldX);
this.y = clamp(this.y, minWorldY, maxWorldY);
  this.zoom = clamp(this.zoom, minZoom, 4.0); // 最大 400%; minZoom = min(0.25, 视口/世界适配缩放)
  this.viewRotation ∈ {0, 90, 180, 270};     // 离散 4 态，Ctrl+R 循环递增
  ```
  
  > **T1.10 修订（动态最小缩放）**: 固定下限 0.25 在 1280×720 视口下只能看到 2880px 高的
  > 世界，64×64 地图（4096px²）无法整图可见，与 T1.10"缩小到 100 个设备都可见"验收冲突。
  > Camera 现按 `min(0.25, min(viewportW/worldW, viewportH/worldH))` 动态取下限
  > （方形世界在 90° 整数倍旋转下四个朝向均整图可见），滚轮与 setZoom 共用。

---

## 5. 常见转换场景

| 场景 | 路径 |
|------|------|
| 鼠标位置 → 点击的设备 | `screenToWorld(mx, my)` → `worldToGrid` → 查询 OccupancyMap |
| 设备 Grid 坐标 → 渲染位置 | `gridToWorld(gx, gy)` → Camera 变换 → pixelAlign |
| 敌人世界位置 → 屏幕位置 | Camera 变换 → pixelAlign |
| UI 元素在设备上方 | `gridToWorld(gx, gy)` + 偏移 → Camera 变换 |

---

## 6. 坐标 Component

```ts
// ECS Component: 世界坐标（浮点，像素）
interface Position {
  x: number;
  y: number;
}

// 设备: Position.x/y = snapToGrid 结果（Cell 左上角世界像素）
// 敌人: Position.x/y = 平滑移动的世界像素
// 子弹: Position.x/y = 每 Tick 更新的世界像素
```

### 6.1 设备放置时的 Position

```ts
// 放置 1×1 设备到 (gridX=5, gridY=3)
const worldPos = gridToWorld(5, 3);  // { x: 320, y: 192 }
entity.addComponent('Position', { x: worldPos.x, y: worldPos.y });
// Sprite 的锚点为 (0, 0) = 左上角，纹理 64×64 正好填满一个 Cell
```

---

## 7. 规则

| 规则 | 说明 |
|------|------|
| **Grid 坐标只能是整数** | `gridX` / `gridY` 的 TypeScript 类型为 `number` 但语义为整数 |
| **不存在 Grid → Screen 捷径** | 必须经过 World + Camera |
| **设备 Position 是 Grid 的像素化** | `Position.x/y = gridX/Y × CELL_SIZE`（仅在放置时计算一次） |
| **像素对齐在渲染时做** | RenderSystem 中 `Math.round()` World→Screen 的结果 |
| **Camera 使用浮点坐标** | 平滑平移需要子像素精度 |
| **CELL_SIZE 为常量** | 不动态改变。需要不同大小则在 Tile 层面做逻辑缩放 |
