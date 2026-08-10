## T2.0 阶段1 传送带创建系统 — 重构计划

### 问题诊断（为什么当前效果糟糕）

对比旧 Flutter 项目（已验证可用），当前 `BeltCreationSystem.ts` 有三处根本性缺陷：

1. **路径计算过于简单**：`computePreviewPath` 只能生成单段 L 形路径（第一段固定沿起点方向、第二段转向目标），目标在起点反方向时直接判无效；遇到障碍不绕行；不支持多锚点折线。旧项目用「动量 L 形 + BFS 兜底」双层算法，支持多锚点（点起点→移动预览→点中继点继续延伸→右键/ESC 落盘）和绕障。

2. **转角渲染数学错误**：旧 Flutter 渲染器对顺时针(CW)与逆时针(CCW)转弯用**两套不同公式**——CW = 按 outAngle 旋转；CCW = 按 (outAngle − π) 旋转 **+ 水平镜像**。当前 `beltCornerRotation` 用单一的「外凸向量」公式，无法覆盖 CCW 情况，导致 4 个转弯方向里有一半渲染错位。

3. **交互模型受限**：当前是「点起点→点终点」两步式，无法连续折线创建。

### 方案：忠实移植旧项目核心算法（不移植截断/合并/物品继承/物流桥——这些是 T2.0 阶段2+ 的事）

---

### 文件改动清单

#### 新增文件

**1. `src/game/systems/belt/BeltPathfinding.ts`** — 路径计算（纯函数，无副作用）
移植旧项目 `belt_direction_utils.dart` 的核心：
- `directionVector(dir)` / `dirName ↔ index` 互转工具
- `calculateMomentumPath(start, end, { verticalFirst, startingDirection })` — 动量 L 形路径
- `findPath(start, end, blocked, { verticalFirst, startingDirection, allowedDirections })` — 双层算法：先试动量路径，验证不被阻挡则用；否则 BFS 兜底
- `findPathBFS(start, end, blocked, ...)` — 4 方向网格 BFS（5000 节点上限，带 firstStep 方向约束）
- `deduplicatePath(path)` — 去重相邻重复格

T2.0 阶段1 的简化：blocked set = 普通设备占用格（不含物流桥/已有传送带交叉的 dir-key 逻辑）；不处理多输入端口建筑的方向排序（阶段2+）。

**2. `src/game/systems/belt/BeltPathGeometry.ts`** — 几何/渲染数学（纯函数）
移植旧项目 `transport_belt_renderer.dart` 的方向判断与转角数学：
- `getCellTurnInfo(path, index)` → `{ isTurn, incomingDir, outgoingDir, isCCW }`（用旧项目的 `(outIdx - inIdx + 4) % 4 === 3` 判 CCW）
- `beltTextureRotation(dir)` — 直段旋转（从现有代码迁移）
- `beltCornerTransform(entryDir, exitDir)` → `{ rotation, mirrorH }` — **CW: rotation = outAngle; CCW: rotation = (outAngle−π+2π)%(2π), mirrorH = true**（与旧项目完全一致）

#### 修改文件

**3. `src/game/components/BeltSegmentComp.ts`** — 扩展组件
- 新增 `entryDir?: Direction`（已有，明确为转角进入方向，与旧项目 `incomingDirection` 对应）
- 新增 `mirrorH?: boolean`（CCW 转角需要水平镜像，存下来供 RenderSystem 读取，避免重复计算）
- `isCorner` 改为可由 path geometry 推导，但保留显式字段供查询

**4. `src/game/systems/BeltCreationSystem.ts`** — 重构核心
保留构造函数签名与对外 API（`toggleMode`/`enterMode`/`exitMode`/`isActive`/`setMouse`/`onPointerDown`/`update`/`destroy`），main.ts/Game.ts 不动。内部重写：
- **状态机扩展**：`idle → hover → preview(多锚点)`。preview 态下左键不再立即落盘，而是**把当前鼠标格作为新中继锚点**加入 `anchors`，继续预览；右键/ESC 才 `_finish()` 落盘整条链。
- **多锚点路径**：维护 `anchors: {x,y}[]` 与 `fullPath`。每次 hover 调 `findPath(anchors.last, mouseGrid, blocked, {startingDirection, verticalFirst})` 得 `previewPath`；左键则把 `previewPath` 合入 `fullPath`、`anchors.push(mouseGrid)`。
- **起点上下文**（移植旧项目 `_handleFirstAnchor` 简化版）：
  - 设备输出端口 → `startingDirection = portOutward`，并按建筑类型算 `allowedDirections`（如分流器禁止往输入端方向）——阶段1 只做单输出端口设备的 `startingDirection`，allowedDirections 先留空（多数设备单一出口方向）
  - 已有断头传送带末端 → `startingDirection = seg.direction`，继承 chainId（阶段2 链管理用）
  - 普通空格/输入端口/设备内部 → 拒绝（与现状一致）
- **verticalFirst 决策**：移植 `_isIncomingVertical()`——比较 `anchors` 最后两点的位移，竖向位移大则 verticalFirst，使 L 形转弯更自然。
- **blocked set**：`OccupancyMap` 已占用格 + 当前 `fullPath` 已含格（防自交）。`findPath` 终点若在已有传送带上则允许（为后续延长留口）。
- **落盘 `_finish`**：遍历 `fullPath`，用 `getCellTurnInfo` 算每格 `isCorner/entryDir/mirrorH`，为每格创建 1×1 Entity（Position + SpriteComp + BeltSegmentComp），写 OccupancyMap。新增字段 `incomingDirection`（链首格继承源端的进入方向，用于首格转角渲染）。
- **转角渲染对齐**：`drawPreview` 和 `createSegment` 都改用 `beltCornerTransform` 产出 `{rotation, mirrorH}`，预览 Sprite 和落盘 Sprite 走同一套数学。

**5. `src/game/systems/RenderSystem.ts`** — 转角渲染对齐（小改）
当前 `update()` 里 beltSeg 分支（131-144 行）调用 `beltCornerRotation`/`beltTextureRotation`。改为：
- 直段：`sprite.rotation = beltTextureRotation(dir)`（不变）
- 转角：读 `beltSeg.entryDir` + `beltSeg.mirrorH`，`sprite.rotation = beltCornerTransform(entryDir, direction).rotation`，若 `mirrorH` 则 `sprite.scale.x = -baseScaleX`（水平镜像）。这样预览/落盘/渲染三方一致。
- 导入改为从 `./belt/BeltPathGeometry` 引入。

**6. `src/game/render/BeltPreviewTintFilter.ts`** — 不动（已正确：整体染蓝/红，透明保持透明）

#### pointer 流动（用户选择「顺便实现」）

**7. `src/game/components/BeltSegmentComp.ts`** 再加 `phaseOffset: number`（每段/每链一个随机相位，避免所有传送带同步流动）。落盘时随机生成。

**8. `src/game/render/BeltPointerRenderer.ts`**（新增）— 专责 pointer 渲染
单独的 RenderSystem 子模块或在 RenderSystem 内新增 belt pointer pass。移植旧项目 `drawItemAt` 数学：
- 全局相位 `globalPhase = (elapsedMS / 2000) % 1`（2 秒一格，与 T2.1 的 40-tick/2s 模型一致），elapsedMS 由主循环累积传入
- 每段本地相位 `localPhase = (globalPhase + seg.phaseOffset) % 1`
- **直段**：pointer 沿方向轴由 `(0.5 − localPhase) × CELL_SIZE` 偏移定位（从一端进、另一端出）
- **转角段**：沿四分之一圆弧运动，pivot = 进入边向量 + 出口边向量之和，半径 0.5 格，角度 `startAngle + localPhase × (isCCW ? −π/2 : π/2)`
- pointer Sprite 用 `pointer.png`（已在 devices 图集，纹理键 `pointer`），尺寸 `CELL_SIZE × 0.35`，按运动切线旋转

**9. `src/main.ts` / `src/game/Game.ts`**（最小改动）
- Game.ts：新增 `elapsedMS` 累积（在 `update(deltaMS)` 里加，main 循环传 deltaMS）
- main.ts 主循环（259-276 行）：把 `ticker.deltaMS` 传给 `game.update()`（当前 update 无参），供 pointer 相位用
- `__game.belt` 已暴露，调试钩子不动

> 注意：pointer 渲染**仅在空载时显示**（T2.1 物品出现时隐藏）。T2.0 阶段1 没有物品，所以 pointer 始终显示——这正好。

---

### 不做的事（明确边界，对应 T2.0 阶段1 范围）
- ❌ 截断已有传送带创建分支
- ❌ 合并孤立传送带
- ❌ 物品状态继承（fork/merge/truncate 时的 segment 迁移）
- ❌ 物流桥作为合法交叉点 + dir-key BFS
- ❌ 设备→传送带/传送带→设备的物品对接（T2.6/T2.7）
- ❌ 链选中高亮/Delete 删除整链（T2.0 阶段2）

---

### 验收方式
- `npm run build`（TypeScript 编译通过）
- 浏览器手动：按 E 进创建模式 → 点设备输出端口（高亮）→ 移动鼠标出现蓝色 L 形预览（含自然转弯方向）→ 继续点中继点延伸折线 → 右键落盘为黄色传送带链
- 转角：创建一条带 2 个转弯的折线，**4 个转弯方向（↑→、→↓、↓←、←↑）都应渲染正确、与邻接直段无缝衔接**
- 障碍绕行：在直线路径上放一个设备，预览自动 BFS 绕开（而非变红）
- pointer：落盘后黄色箭头沿传送带循环流动（直段直线、转角弧线），2 秒走一格
- 反向测试：目标在起点反方向时，BFS 找不到路 → 预览变红
- 用 `__game.belt` 调试钩子确认状态机转换

### 风险点
- BFS 移植需仔细对照 dart 的 visited/parent 回溯逻辑（含 dir-key），但阶段1 简化后无 dir-key，回溯更简单
- pointer 圆弧数学的坐标系约定（屏幕 y 向下）需与旧 Flutter Canvas 一致，会画一个测试折线目视验证 4 个转角方向
- mirrorH 用 `scale.x = -baseScaleX` 实现，需确认 RenderSystem 的 scale 重置逻辑（131 行先 set 回 baseScale）不会在后续帧把镜像冲掉——改为在镜像分支里 set 负值即可