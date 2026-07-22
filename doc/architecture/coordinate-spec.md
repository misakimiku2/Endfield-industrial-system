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

  // 世界坐标 → 屏幕坐标
  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const screenCenterX = canvasWidth / 2;
    const screenCenterY = canvasHeight / 2;
    return {
      x: (wx - this.x) * this.zoom + screenCenterX,
      y: (wy - this.y) * this.zoom + screenCenterY,
    };
  }

  // 屏幕坐标 → 世界坐标
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const screenCenterX = canvasWidth / 2;
    const screenCenterY = canvasHeight / 2;
    return {
      x: (sx - screenCenterX) / this.zoom + this.x,
      y: (sy - screenCenterY) / this.zoom + this.y,
    };
  }
}
```

### 4.1 相机约束

```ts
// Phase 1 约束
this.x = clamp(this.x, minWorldX, maxWorldX);
this.y = clamp(this.y, minWorldY, maxWorldY);
this.zoom = clamp(this.zoom, 0.25, 4.0);  // 最小缩放 25%, 最大 400%
```

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
