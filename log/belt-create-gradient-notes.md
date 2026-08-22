# 创建模式终点传送带「黄→蓝」渐变 — 问题与几何笔记

> 目的：新会话快速接手。本文记录「创建传送带时，链尾（终点）段的带身出现黄→蓝渐变」这个视觉效果的
> 需求、代码位置、坐标几何、已尝试方案与当前卡点。
>
> 关键结论先行：**直段渐变已正确（FillGradient textureSpace='global'）；转角的渐变仍然不对**，
> 根因是转角黄带环的「外弧圆心」与「内弧圆心」**不同心**，导致不能用简单的同心扇形/环带去覆盖。

---

## 1. 需求

创建传送带时（BeltCreationSystem），整条链的**最后一个段**（终点段，`createTail`）的带身
（Status 黄带）要做成「黄 → 蓝」渐变，表示"输出/创建"的终点指示。

规则：

- **段首（起点）＝ 黄**，**段尾（末端）＝ 蓝**。
- **蓝色方向始终指向传送带走向（direction）**，即末端永远是蓝。
  - 走向 →（右）：左黄 → 右蓝。
  - 走向 ↑（上）：下黄 → 上蓝。
  - 依此类推。
- 直段、转角都要有这个渐变。

---

## 2. 颜色与常量

定义在 `src/game/render/BeltVectorGeometry.ts`：

| 常量 | 值 | 含义 |
|---|---|---|
| `BELT_COLOR_BELT` | `0xffef00` | 黄（带身原色，段首） |
| `BELT_COLOR_CREATE` | `0x80bee9` | 蓝（创建终点色，段尾） |
| `BELT_COLOR_STATUS_BLOCKED` | `0xb10000` | 堵塞红（另一个状态，别混淆） |

传参入口 `src/game/render/BeltVectorRenderer.ts` 约 150-152 行：

```ts
} else if (createTail) {
  // 创建模式终点：沿"段首 → 段尾"方向 黄 → 蓝 渐变（段首黄、段尾蓝，末端始终蓝）
  colors = { beltGradient: { from: BELT_COLOR_BELT, to: BELT_COLOR_CREATE } };
}
```

`BeltColors.beltGradient = { from, to }`：`from` = 段首色，`to` = 段尾色。

绘制函数（都在 `src/game/render/BeltVectorGeometry.ts`）：

- `drawStraightBelt(g, cellSize, colors, dir)` — 直段（第 89 行）。
- `drawCornerBelt(g, cellSize, colors)` — 转角（第 151 行）。

颜色插值工具 `lerpColor(a, b, t)`（第 62 行）：对两个 0xRRGGBB 做线性插值。

---

## 3. 坐标系统（重要）

- 每个格子以**格子中心为原点**，单位 = world 像素（由 `cellSize` 传入，通常是 `CELL_SIZE = 64`）。
- 素材 SVG viewBox = `0 0 16.933333`，格子中心 = `8.4666665`。
- 缩放系数 `s = cellSize / 16.933333`；半格 `c = 8.4666665 * s = cellSize / 2`（即 32px / 0.5cell）。
- 本地坐标换算：`world = (viewBox - 8.4666665) * s`。

方向约定（`Direction`）：`0=右, 90=下, 180=左, 270=上`，屏幕坐标系（y 向下）。

### 直段方向旋转（`beltTextureRotation`）

定义在 `src/game/systems/belt/BeltPathGeometry.ts` 第 194 行：

```ts
dir=0   →  π/2
dir=90  →  0
dir=180 → -π/2
dir=270 →  π
```

直段黄带在本地是**纵向**（默认朝下）：段首 = 本地 `-y`（上），段尾 = 本地 `+y`（下）。
`beltTextureRotation` 把「本地 +y（段尾）」旋转到 direction 方向。

直段渐变通过实测得到的关键结论（已正确）：

| dir | 段尾在本地位置 | start（段首·黄） | end（段尾·蓝） |
|---|---|---|---|
| 90（下）/ 270（上） | `+y`（下） | `y = -half` | `y = +half` |
| 0（右）/ 180（左） | `-y`（上） | `y = +half` | `y = -half` |

### 转角方向旋转（`beltCornerTransform`）

`BeltPathGeometry.ts` 第 220 行。默认形状是「下→右」转角（入口下、出口右，外凸右下），
CW 用 `rotation = directionAngle(exitDir)`，CCW 用反向旋转 + 水平镜像。

---

## 4. 直段实现（已正确，勿动）

`drawStraightBelt` 用 `FillGradient` + `textureSpace: 'global'`：

```ts
const grad = new FillGradient({
  type: 'linear',
  start: { x: 0, y: startY },   // 段首（黄）
  end:   { x: 0, y: endY },     // 段尾（蓝）
  colorStops: [
    { offset: 0, color: from },  // 黄
    { offset: 1, color: to },    // 蓝
  ],
  textureSpace: 'global',        // 必须显式指定！默认 'local' 会出错
});
```

其中 `startY/endY` 按上表根据 `dir` 决定。这段已通过验证，**不要改**。

---

## 5. FillGradient 的坑（PixiJS v8）

- `textureSpace` 默认是 **`'local'`**（不是 `'global'`）。
- `'local'`：`start/end` 是**归一化 0~1 坐标**，内部固定按 `textureSize=256` 映射到 256px，
  **与形状实际尺寸（64px）不匹配** → 渐变方向/范围全错（曾表现为"蓝色始终在上方"）。
- `'global'`：`start/end` 是 **Graphics 本地像素绝对坐标**，纹理从 start 沿 start→end 方向
  延伸 `dist = |end - start|` 像素，正好覆盖目标长度 → 平滑无阶梯。

因此：**直段用 'global' + 像素坐标是正解**。转角之所以麻烦，是因为它不只是"一条直线"。

---

## 6. 转角几何（当前卡点核心）

转角黄带环（`circle5`）SVG path（`Transport_Belt_rotate.svg`）：

```
M 16.933333,3.96875
A 12.964583,12.964583 0 0 0 3.96875,16.933333
h 8.995833
a 3.96875,3.96875 0 0 1 3.96875,-3.96875
z
```

换算到本地（cell 单位，1 cell = 16.933333 viewBox）：

| 点 | viewBox | 本地(cell) | 说明 |
|---|---|---|---|
| M | (16.933, 3.96875) | (0.5, -0.266) | 右上（外弧起点 A） |
| 外弧终点 | (3.96875, 16.933) | (-0.266, 0.5) | 左下（外弧终点 B） |
| h 终点 | (12.9646, 16.933) | (0.266, 0.5) | 右下（内弧起点 C） |
| a 终点 | (16.933, 12.9646) | (0.5, 0.266) | 右上偏下（内弧终点 D） |

### 6.1 外弧（大弧，物品路径所在）

- 圆心 = **(c - beltOuter, c - beltOuter) = (-0.266, -0.266) cell（"左上"）**
- 半径 `beltOuter = 12.964583 * s ≈ 0.766 cell`
- 弧从 A(0°) 顺时针到 B(90°)（sweep=0），**经过右下 45°** → 外凸右下。
- 物品路径 = 这段弧的「下 → 右」部分：入口 B(90°, 下) → 出口 A(0°, 右)，**角度减小**。

### 6.2 内弧（小弧）

- 圆心 = **(c, c) = (0.5, 0.5) cell（"右下"）**
- 半径 `inner = CORNER_R_INNER * s = 2.645833 * s ≈ 0.156 cell`
- 弧从 C 到 D（sweep=1）。

### 6.3 根本难点：外弧圆心 ≠ 内弧圆心

外弧圆心在 `(-0.266, -0.266)`（左上），内弧圆心在 `(0.5, 0.5)`（右下），
两点距离 ≈ 1.083 cell。**黄带环不是标准的同心四分之一圆环**（它是"外弧+内弧不同心"的交叉环带）。

因此：
- 用「同心环带扇形」（外弧与内弧共用左上圆心）只能精确覆盖外弧附近，**覆盖不到内弧附近** → 表现成"只贴了一片、位置/大小不对"。
- 用「对角线线性渐变」（FillGradient 沿入口→出口直线）方向对但**不贴合弧形** → 颜色分布不自然。

### 6.4 另外两个几何偏差（drawCornerBelt 与 SVG 不完全一致）

`drawCornerBelt` 当前画黄带环用的参数与 SVG 有两处偏差（可能是历史近似/笔误）：

1. `lineTo(shellOuter - c, c)` 用了 `shellOuter`（灰壳外弧半径 14.2875），SVG 的 `h 8.995833`
   终点应该是 `beltOuter`（黄带外弧半径 12.964583）。→ 内弧起点 x 偏了。
2. 内弧用 `inner = 2.645833`（这是**灰壳内弧** `CORNER_R_INNER`），SVG 黄带内弧其实是
   `3.96875`（`CORNER_CORNER_R`）。→ 内弧半径偏小。

做转角渐变时若想精确覆盖黄带环，建议先确认是否要**修正这两处几何**（或至少与渐变使用同一套几何）。

---

## 7. 当前代码状态（截至本笔记）

- 直段 `drawStraightBelt`：FillGradient 'global'，**正确**。
- 转角 `drawCornerBelt`：当前是 **「同心环带扇形」方案**，仍有问题：

  ```ts
  beltPath.fill({ color: from });                 // 底色 from（黄）
  const N = 32;
  const ocx = c - beltOuter, ocy = c - beltOuter; // 左上圆心
  const innerR = beltOuter * 0.55;                // 同心内半径
  // 每段：外弧(ocx,ocy,beltOuter) + 内弧(ocx,ocy,innerR) 扇形，fill lerp 色
  ```

  问题：`innerR` 是"左上圆心的同心半径"，而黄带环内弧实际在"右下 (c,c)"，所以扇形只覆盖外弧
  附近一圈，**内弧附近大片是底色 from（黄）**，表现为"位置不对、小了、只贴了一片"。

---

## 8. 已尝试方案历史

| 版本 | 方案 | 结果 |
|---|---|---|
| v1 | FillGradient 默认 `'local'`（归一化 0~1） | 蓝固定在上方，方向/范围错 |
| v2 | 直段分段色块 N=8 | 阶梯色戒；转角用格中心扇形 → 错位 |
| v3 | 直段/转角 FillGradient `'global'` 对角线 | 直段正确；转角直线渐变不贴合弧形 |
| v4 | 转角同心环带扇形（当前） | 只贴外弧一片，覆盖不到内弧 |
| v5（思路，未落地验证） | 转角**非同心**分段：外弧用左上圆心、内弧用右下圆心 (c,c)，每段画「外弧弧+径向线+内弧弧+径向线」小四边形 | —— |

---

## 9. 建议下一步

转角渐变要同时满足「沿外弧方向渐变」+「完整覆盖外弧~内弧」，建议方向：

1. **非同心分段小四边形**（v5 思路）：每段用
   - 外弧：圆心 `(c - beltOuter, c - beltOuter)`、半径 `beltOuter`，角度 `a: 90°→0°`；
   - 内弧：圆心 `(c, c)`、半径 `inner`，角度 `b = 270° - a`（C 端 180° / D 端 270°）；
   - 段间两条「径向连接线」闭合，每段 fill `lerpColor(from, to, t)`，`t = i/N`。
   这样每一小段都精确落在黄带环上（外弧、内弧都用真实圆心），拼起来即完整覆盖。

2. 或者**先把 `drawCornerBelt` 的黄带环几何修正为与 SVG 一致**（6.4 的两处偏差），
   再用标准几何做渐变（若内外弧仍是不同心，仍需非同心分段）。

3. 若想彻底简化：也可以考虑放弃"沿弧渐变"，改为转角整段用单一 `FillGradient`（'global'，
   沿入口→出口对角线）并接受"弧形上的线性渐变不完美"；或把转角渐变降级为「出口半段蓝色、
   入口半段黄色」的二分（非平滑）方案。

---

## 10. 相关文件清单

- `src/game/render/BeltVectorGeometry.ts` — 直段/转角绘制、颜色常量、`lerpColor`。
- `src/game/render/BeltVectorRenderer.ts` — `createTail` 传入 `beltGradient`。
- `src/game/systems/belt/BeltPathGeometry.ts` — `beltTextureRotation`、`beltCornerTransform`、`directionAngle`。
- `src/game/systems/BeltCreationSystem.ts` — 创建/预览流程（预览用单色，不涉及渐变）。
- 素材 `src/assets/svg/Transport_Belt_Move.svg`（直段）、`Transport_Belt_rotate.svg`（转角）。
