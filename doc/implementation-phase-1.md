# Phase 1 — 核心框架实施计划

> **目标**: ECS + 渲染基础，显示 100 个静态工业设备  
> **周期**: 2 周（按单人+AI 节奏估算）  
> **起点**: Phase 0 脚手架已就绪，ECS.ts / ObjectPool.ts 已有基础实现

---

## 进度总览

| 任务 | 状态 | 核心产出 |
|------|------|----------|
| T1.1 ECS 核心完善 | ✅ 完成 | `src/game/ECS.ts`（generation-based EntityHandle） |
| T1.2 相机系统 | ✅ 完成 | `Camera.ts` / `CameraController.ts` / `SceneRenderer.ts` |
| T1.3 SVG/PNG 资源管线 | ✅ 完成 | `scripts/pack-assets.ts` / `AssetsLoader.ts`（三图集） |
| T1.4 世界网格渲染 | ✅ 完成 | `GridRenderer.ts`（分段 alpha + Canvas2D 暗角） |
| T1.5 视图操作 | ✅ 完成 | 边缘滚动、Ctrl+R 视图旋转(屏幕相对参考系+平滑过渡)、`screenDirToWorld`/`panByScreen`、GridRenderer 旋转感知 |
| T1.6 渲染系统 | ⬜ 待开发 | 实体↔Sprite 绑定、视口剔除 |
| T1.7 基础交互系统 | ⬜ 待开发 | 点击选中、选中框 |
| T1.8 设备放置系统 | ⬜ 待开发 | 工具栏、放置预览、OccupancyMap、放置前旋转(R键) |
| T1.9 设备删除 | ⬜ 待开发 | 删除已放置设备(Delete键)、占位释放 |
| T1.10 性能基准测试 | ⬜ 待开发 | 100 设备 FPS ≥ 55 |

> **文档修订**: DD-008 已修订（设备 SVG / 物品 PNG 双格式，见 core-decisions.md）。  
> **PixiJS 踩坑**: 见文末 [附录 A：PixiJS v8 踩坑记录](#附录-a-pixijs-v8-踩坑记录)，T1.5/T1.6 开发前务必阅读。

---

## 依赖关系图

```
T1.1 ECS 完善 ──────────────────────┐
                                     │
T1.2 相机系统 ──────────────────────┤
                                     ├──→ T1.5 视图操作 ──→ T1.6 渲染系统 ──→ T1.7 交互 ──→ T1.8 放置 ──→ T1.9 设备删除
T1.3 SVG 资源管线 ──────────────────┤        (边缘滚动        (实体↔Sprite         (选中)        (工具栏+       (Delete键
                                     │       +Ctrl+R 视图        绑定)                          放置预览)      占位释放)
T1.4 世界网格 ──────────────────────┘        旋转, 改 Camera)                                                       │
                                                                                                                     ↓
                                                                                                               T1.10 性能基准
```

> **T1.5 为何排在 T1.6 渲染之前**：视图旋转（Ctrl+R）会改 Camera 变换，下游所有用 `worldToScreen`/`screenToWorld` 的系统（T1.6 渲染、T1.7 交互、T1.8 放置）必须一开始就建成"旋转感知"的，否则后面返工面大。T1.5 把 Camera 改造好，后续任务直接用。
> **T1.9 依赖说明**：删除需要 `OccupancyMap.release`（T1.8 建）+ `destroyEntity`（T1.1 已完成）+ 选择态（T1.7）。
> **操作交互约定**：放置模式下右键 = 取消放置（退出放置模式）；非放置模式下 Delete 键 = 删除选中设备。两套语义不重叠。

---

## T1.1 — ECS 核心完善

### 当前状态
`ECS.ts` 已实现基础 World：`createEntity / removeEntity / addComponent / getComponent / hasComponent / removeComponent / query`

### 需要补充
- Entity ID 改为 generation-based（DD-001），外部代码使用 EntityHandle 而非裸 number
- 新增 `destroyEntity(handle)` 和 `isAlive(handle)` 方法
- 移除旧的 `removeEntity`（被 `destroyEntity` 替代）

### 验收标准（你看不到变化，这是底层改造）
- 你**看不到任何变化**，这是纯代码重构
- 验证方式由 AI 执行：`isAlive(已销毁的handle)` 返回 false，确认 generation 已递增

### 预估工时
1 次会话

### ✅ 实现备注（已完成）
- **产出文件**: `src/game/ECS.ts`（推倒重写）、`src/game/components/TurretComp.ts`（修复 Entity→EntityHandle）、`scripts/verify-t1.1-ecs.ts`（40 条断言验证）
- **Handle 编码**: `(generation << 20) | index`，index 槽位 freelist 回收，generation 12 位（4096 代后回绕，实际游戏不触发）
- **API**: `createEntity/destroyEntity/isAlive/entityCount` + `addComponent/getComponent/hasComponent/removeComponent` + `query`
- **组件存储**: 按 index 键入（非 handle），销毁时整槽清空，槽位复用时组件天然从零开始
- **验证**: `node --experimental-strip-types scripts/verify-t1.1-ecs.ts` → 40/40 通过；`tsc --noEmit` 零错误
- **已知张力点**: `TurretComp.target` 引用 `EntityHandle`（A1 §2.2 规定 Component 不引用 Entity），Phase 3 塔防索敌时改用空间查询解除耦合

---

## T1.2 — 相机系统

### 目标
实现 2D 俯视相机的平移和缩放。

### 需求
- 平移：鼠标中键拖拽 或 键盘 WASD
- 缩放：滚轮缩放，以鼠标位置为中心
- 相机边界：世界范围限制在 64×64 cells 内

### 验收标准（你在浏览器看到的效果）
- **打开浏览器** → 看到黑色背景上的灰色网格
- **按住鼠标中键拖拽** → 画面平滑平移，无闪烁
- **滚动滚轮** → 画面以鼠标位置为中心放大/缩小
- **放大到最大（4×）** → 网格线清晰，无模糊
- **缩小到最小（0.25×）** → 看到大范围网格

### 预估工时
1~2 次会话

### ✅ 实现备注（已完成）
- **产出文件**: `src/game/render/Camera.ts`、`CameraController.ts`、`SceneRenderer.ts`、`constants.ts`、`scripts/verify-t1.2-camera.ts`
- **Camera**: 纯逻辑类，`worldToScreen`/`screenToWorld` 互逆、`panByWorld`、`zoomAt(anchor)`（以鼠标为锚点缩放）、边界 clamp（世界边缘贴视口边缘，世界小于视口时居中）
- **变换同步**: `updateTransform()` 写入 `worldContainer.position/scale`（公式 `pos = viewportCenter − camCenter × zoom`）
- **输入**: 中键拖拽（反向跟随）、WASD/方向键（帧率无关 900px/s）、滚轮（1.15^dir 以鼠标为中心）
- **场景层**: A2 §4 七层 Container（backgroundLayer + worldContainer[6层] + overlayLayer），sortableChildren 开启
- **验证**: 相机纯逻辑 13/13 单测通过；浏览器实测平移/缩放/拖拽/边界全正确，FPS 59
- **调试钩子**: `window.__game = { app, camera, gridRenderer, getTexture }`（开发期保留）

---

## T1.3 — SVG 资源管线

### 目标
把你放在 `src/assets/svg/` 里的 SVG 文件，变成游戏能用的纹理。

### 需求
- 构建脚本将 SVG 批量转为纹理图集
- 游戏运行时能通过 `Assets.get('texture_name')` 获取纹理

### 验收标准（你在浏览器看到的效果）
- **你不需要看到任何画面变化**
- 验证方式：AI 打开浏览器控制台，输入代码确认纹理加载成功、无 404 报错

### 预估工时
1 次会话

### ✅ 实现备注（已完成）
- **产出文件**: `scripts/assets/asset-manifest.ts`、`scripts/assets/packer.ts`、`scripts/pack-assets.ts`、`src/game/render/AssetsLoader.ts`
- **文档修订**: DD-008 修订为"设备/UI 用 SVG、物品用 PNG"（见 core-decisions.md）
- **管线**: 自写构建脚本 + `sharp` 光栅化 SVG → shelf-pack 打包 → `{devices,items,ui}.{png,json}`
- **图集产出**: devices(9块,1024×256) / items(93块,4096×2048) / ui(28块,2048×256)
- **图集上限 4096**: WebGL2 安全上限（原 2048 装不下 93 个 254px 物品图标）
- **texture key 映射**: 文件名→小写→非字母数字替 `_`；手工覆盖表（`3x3_unit→refining_unit` 等）
- **运行时**: `AssetsLoader.loadAll()` 加载三图集，`getTexture(group, key)` 统一访问
- **npm script**: `npm run pack-assets`（改 SVG 后重跑）；产物在 `public/spritesheets/`（.gitignore 排除）
- **验证**: 三个 JSON 全 200 无 404；texture key 全部正确；`tsc` 零错误
- **设备纹理缺口**: building-spec 定义的 `shredding_unit`/`fitting_unit`/`moulding_unit` 等缺 SVG，留 T1.7 处理
- **已知**: 物品 PNG 尺寸不完全统一（254×254 为主，少数 256×256 / 128×128 / 254×236）

---

## T1.4 — 世界网格渲染

### 目标
渲染一个带网格线的世界背景。

### 需求
- 浅灰色网格线（#D6D4D4），间距 64px（对齐 Cell 大小）
- 只渲染屏幕可见范围内的网格线（性能优化）
- 网格线像素对齐，平移时无模糊抖动

### 验收标准（你在浏览器看到的效果）
- **打开浏览器** → 看到浅灰色背景（#E6E4E4）上的网格线
- **网格线颜色** → 浅灰色（#D6D4D4），间距64px
- **屏幕四角** → 有从透明渐变为深色的暗角效果
- **屏幕边缘** → 网格线靠近边缘时逐渐变透明，到边缘完全消失
- **拖拽平移** → 网格线平滑跟随，不闪烁、不重影
- **缩放** → 网格线始终清晰
- 网格线覆盖整个视口，没有空白区域

### 预估工时
1 次会话

### ✅ 实现备注（已完成）
- **产出文件**: `src/game/render/GridRenderer.ts`（重写 3 次）、改造 `SceneRenderer.ts`、`main.ts`
- **背景底色**: `#E6E4E4` Graphics 矩形铺满视口（屏幕空间 backgroundLayer）
- **网格线**: `#D6D4D4` 1px / 64px，每帧按相机可见范围重绘，`Math.round` 像素对齐，只画视口内
- **边缘渐隐**: 网格线分 12 段，每段按距视口中心的**对角线归一化距离**设 alpha（0.55 内=1.0，到 1.0=角衰减到 0.25）。**必须用对角线归一化**，用短边会导致宽屏左右网格消失
- **暗角**: Canvas 2D `createRadialGradient` 生成纹理 Sprite（**不用 PixiJS FillGradient**，见附录 A.1），alpha 0.2，对角线归一化
- **视口同步**: 主循环每帧轮询 `app.screen` 尺寸变化（**不用 window.resize 事件**，见附录 A.3）
- **验证**: 宽屏 1791×1089 网格铺满无空白；中心 228 / 边缘 198 / 四角 180；resize 循环无崩溃无错位
- **踩过的坑**: FillGradient 压暗中心、Sprite mask resize 崩溃、resize 事件时序竞争——详见附录 A

---

## T1.5 — 视图操作（边缘滚动 + 视图旋转）

### 目标
补齐相机层的两项 QoL 操作：鼠标到窗口边缘自动平移（RTS 风格）、Ctrl+R 顺时针旋转整个视图 90°。

### 背景
WASD 平移和滚轮缩放已在 T1.2 实现。边缘滚动是相机平移的便捷增强；视图旋转（类似 Factorio）则是一个**会级联影响下游所有系统**的改造——它改变 Camera 变换，因此 T1.6 渲染 / T1.7 交互 / T1.8 放置都必须从一开始就建成"旋转感知"的。本任务排在 T1.6 之前，正是为了把 Camera 改造好，后续任务直接消费。

> **参考系决策（已确认）**：
> - **WASD / 边缘滚动 → 屏幕相对**：无论视图怎么转，W 永远让画面向上平移、鼠标到屏幕上边永远向上滚（符合 RTS / Factorio 习惯）。
> - **R 键（设备放置/旋转）→ 相对视图**：视图转 90° 后按 R，设备在屏幕上看起来转 90°（即玩家面对屏幕操作）。详见 T1.8 放置章节。
>
> **为何都用屏幕相对/相对视图而非世界相对**：玩家操作的是屏幕上的画面，不是世界坐标系。屏幕相对在视图旋转后直觉一致，不会出现"按 W 画面却往右移"这种反直觉行为。

### 需求

**边缘滚动（Edge Scrolling）**
- 鼠标移到距窗口边缘 N px（默认 32px）的触发带内 → 画面向该方向自动平移
- 平移速度帧率无关，对齐 WASD 的 900px/s
- 到达世界边界时优雅停止（不抖动、不越界，复用 T1.2 的边界 clamp）
- 8 方向（上/下/左/右 + 四个对角）支持
- **与放置模式共存**：放置预览模式（T1.8）下鼠标到边缘，预览跟随平移后的画面移动（这是期望行为，方便往远处放设备）

**视图旋转（View Rotation）**
- `Ctrl+R` → 整个视图顺时针旋转 90°（4 个离散状态：0° / 90° / 180° / 270° → 循环回 0°）
- 旋转以**屏幕中心**为枢轴（等价于相机视线中心不动，世界绕它转）
- Camera 新增 `viewRotation: 0 | 90 | 180 | 270` 状态
- `worldToScreen` / `screenToWorld` 复合旋转（world → 屏幕中心相对坐标 → 绕中心旋转 viewRotation → × zoom → + 屏幕中心；`screenToWorld` 是逆运算）
- `updateTransform` 把 viewRotation 写入 `worldContainer`（PixiJS 的 rotation + 配合 pivot/anchor 处理枢轴）
- **WASD/边缘滚动按屏幕相对重映射**：视图转 θ° 后，屏幕"上"方向对应世界方向旋转 θ°，平移量要按此映射到相机世界坐标增量。例如视图转 90° 时，按 W（屏幕上）实际让相机世界 Y 减小
- **滚轮缩放仍以鼠标为锚点**：缩放逻辑不变，但要验证在旋转视图下锚点计算正确
- 世界边界 clamp 在旋转视图下仍生效（旋转不改变相机可看的世界范围，只改变呈现方式）

### 验收标准（你在浏览器看到的效果）

**边缘滚动**
- **鼠标移到窗口右边缘 32px 内** → 画面向右持续平移，到世界右边界停下
- **鼠标移到右上角** → 画面向右上对角平移
- **鼠标回到画面中央** → 平移停止
- **同时按 W + 鼠标在边缘** → 两者叠加平移（不冲突）
- **放置预览模式下移到边缘** → 画面平移，预览跟随（验证不报错、不错位）

**视图旋转**
- **按 Ctrl+R** → 整个画面（网格 + 设备，测试时 AI 先放几个设备）顺时针转 90°，屏幕中心位置的内容不动
- **连按 4 次 Ctrl+R** → 转满一圈回到 0°，画面与旋转前完全一致
- **旋转后按 W** → 画面向屏幕上方移动（不是世界北），即屏幕相对生效
- **旋转后鼠标移到屏幕上边缘** → 画面向屏幕上方滚动
- **旋转后拖拽/缩放** → 网格、设备、选中框（如有）位置正确跟随
- **旋转视图下，AI 在控制台点击屏幕坐标** → `screenToWorld` 返回正确的世界坐标（旋转逆变换无误，AI 验证）
- **旋转视图下网格仍铺满视口** → 无空白、无错位、边缘渐隐/暗角正常（这些是屏幕空间效果，不受视图旋转影响）
- 网格线在旋转后仍像素对齐、清晰不模糊

### 预估工时
1~1.5 次会话（Camera 旋转数学 + 边缘滚动 + WASD 屏幕相对重映射 + 旋转下各操作的回归验证）

### ⚠️ 实现提醒（给后续 AI）
- **GridRenderer 回炉风险**：T1.4 已完成的网格渲染读的是相机可见范围。视图旋转后，可见的"世界矩形"变成了旋转后的矩形，`GridRenderer` 按 camera 可见范围画线时需确认其能正确处理旋转后的可见区域。若 T1.4 实现是按轴对齐矩形算可见范围，本任务要扩展它支持旋转矩形（或改为"画一个足够大的旋转网格 + 用视口裁剪"）。
- **所有坐标转换必须经过 Camera**：旋转正确性的前提是没有任何代码绕开 `Camera.worldToScreen`/`screenToWorld` 自己算坐标。本任务完成后，审计 T1.6~T1.10 的实现是否都走 Camera，是确保旋转生效的关键。
- **旋转是渲染/输入层概念，不进 ECS**：模拟层（Phase 2 的传送带/机器）是世界相对的，完全不感知 viewRotation。不要把旋转信息存进任何 Component。

### ✅ 实现备注（已完成）
- **产出文件**: `Camera.ts`（加 viewRotation/rotateClockwise/screenDirToWorld）、`CameraController.ts`（Ctrl+R + 边缘滚动 + WASD 屏幕相对）、`GridRenderer.ts`（旋转感知重写 update）、`constants.ts`（边缘滚动常量）、`main.ts`（HUD 显示 rot）、`scripts/verify-t1.5.ts`（49 条断言）、`scripts/ts-loader.mjs`（让 verify 脚本能跑无后缀 import）
- **Camera 旋转数学** (A6 §4/§4.0): `worldToScreen` 用 `rad = -displayRotation`（视图顺时针=内容逆时针呈现），`screenToWorld` 逆运算用 `rad = +displayRotation`。4 旋转态逐点互逆。`displayRotation` 是连续弧度（平滑动画用），动画结束后等于 `viewRotation`（离散目标态）对应弧度。
- **updateTransform 用 pivot 方式**: `pivot=camCenter`, `position=VP/2`, `scale=zoom`, `rotation=-displayRotation`。绕相机中心(=屏幕中心)旋转。rot=0 退化为旧公式且逐像素一致。**不用** PixiJS 的 pivot+position 手动算，让 PixiJS 自己处理枢轴。
- **screenDirToWorld**: 把屏幕方向向量映射到世界方向（WASD/边缘滚动/中键拖拽共用）。rot=90 时屏幕上(0,−1)→世界右(+1,0)，按 W 让相机 X 增加。
- **panByScreen（中键拖拽屏幕相对）**: 拖拽位移先经 `screenDirToWorld` 映射再平移，使旋转视图下拖拽方向直觉一致（鼠标上拖→画面上移），与 WASD 同一套参考系。**早期实现用 panByWorld 直接按世界位移，旋转后拖拽方向诡异（rot=90 鼠标上拖画面左移），已修复**。
- **平滑旋转过渡**: `viewRotation` 是离散目标态，内部 `_displayRotation`(连续弧度)由 `update(dt)` 每帧 ease-in-out cubic lerp 向目标，动画结束吸附精确值。所有坐标转换与 updateTransform 都用 `_displayRotation`，保证过渡期间视觉与点击位置严格一致。连按 Ctrl+R 时以当前 displayRotation 为新起点接续，无角度突变。动画时长 `CAMERA_ROTATE_ANIM_MS=220ms`。
- **GridRenderer 旋转感知（回炉风险已解决）**: 旋转后世界竖直线在屏幕上变斜线/水平线（rot=90→水平），不能再用"每条线屏幕 x 恒定"画法。重写为：取世界网格线两点→worldToScreen→屏幕直线→参数化裁剪到视口矩形(Liang-Barsky 风格)→分段设 alpha。可见范围用**四角世界坐标的 AABB**（旋转矩形包围盒，两角法只在 0/180° 充分）。连续中间角度(如 52°)下网格仍铺满无空白。
- **边缘滚动**: 鼠标在窗口边缘 32px 触发带内 → 8 方向滚动。`mouseInside` 追踪（mouseenter/leave + mousemove 内容差判定），离开 canvas 不触发。速度 900px/s 对齐 WASD，与 WASD 叠加成屏幕方向向量后统一映射。
- **边缘贴边容差**: 鼠标精确贴屏幕最右/下缘时 `clientX` 可能略微超出 `clientWidth`（亚像素）。`mouseInside` 判定加 2px 容差，边缘滚动判定去掉 `≤ w` 上界（触发带 `[w−m, +∞)`），确保贴边滚动不失效。
- **Ctrl+R**: 在 onKeyDown 拦截 `Ctrl/Cmd+KeyR`，preventDefault 阻止浏览器刷新，调 `rotateClockwise()`。不进 WASD 状态机。
- **验证（纯逻辑）**: `node --experimental-strip-types --experimental-loader ./scripts/ts-loader.mjs scripts/verify-t1.5.ts` → 49/49 通过（互逆/中心枢轴/4态循环/屏幕相对方向/zoomAt锚点/clamp/zoom边界）。`tsc --noEmit` 零错误，`vite build` 成功。
- **验证（浏览器实测）**: 全部验收标准实测通过——
  - Ctrl+R 旋转 90°，连按 4 次回 0°，旋转不改相机中心（前后均 2048,2048）
  - **平滑过渡**：按下后 `isRotating=true`，500ms 处已转到 52°（2000ms 测试时长下），结束吸附 90°；52° 中间态网格呈对角线、边缘覆盖 79.1%（无空白）
  - **中键拖拽屏幕相对**：rot=90 鼠标上拖 100px → 世界固定点屏幕 Y −100（画面上移，方向直觉一致，不再"画面左移"）
  - rot=90 按 W → 相机 X +12.42、Y 不变（屏幕相对，非世界相对）
  - 边缘滚动 8 方向：右上角对角滚动 rot=0 → X+1416/Y−1763（clamp 在边界）
  - rot=90 上边缘滚动 → 相机 X 增大 Y 不变（屏幕相对在边缘滚动也生效）
  - rot=90 滚轮缩放 → 锚点世界坐标缩放前后完全一致（3498.5,2316.0）
  - 旋转网格铺满：rot=0/90/270 边缘暗像素覆盖均 79.6%（旋转无空白）
- **ts-loader 说明**: Node 24 的 `--experimental-strip-types` 不解析无后缀 import（ESM 要求显式后缀，且 `./foo.js` 匹配不到 `./foo.ts`）。`scripts/ts-loader.mjs` 把无后缀相对 import 重写到 `.ts`。**注意**: 旧的 verify-t1.1/t1.2 现在也需要带 loader 跑（T1.4 拆出 constants.ts 后它们已无法直接 `node --experimental-strip-types` 运行）。
- **调试钩子扩展**: `window.__game` 新增 `controller`（CameraController 实例），便于控制台验证输入状态。

---

## T1.6 — 渲染系统

### 目标
建立 ECS 实体和画面上 Sprite（精灵图）之间的绑定：创建实体→显示图片，销毁实体→图片消失。

### 需求
- ECS 实体带 Position + SpriteComp 组件 → 自动创建 Sprite 显示在画布上
- 实体销毁 → Sprite 自动从画布移除
- 相机平移缩放 → 设备位置正确跟随
- 视口剔除：屏幕外的设备自动隐藏（不浪费性能）

### 验收标准（你在浏览器看到的效果）
- **这个任务完成后**：画面上看不到变化（因为还没有"放置设备"的功能）
- 验证方式：AI 在控制台执行一段测试代码，10 个设备图标出现在网格上
- 你能看到 10 个设备图标排列在网格上
- 拖拽相机 → 设备跟随移动
- 放大/缩小 → 设备大小变化
- **（T1.5 视图旋转的回归）旋转视图后** → 设备位置仍正确跟随旋转（证明 RenderSystem 走的是 Camera 变换）

### 预估工时
1~2 次会话

---

## T1.7 — 基础交互系统

### 目标
点击地图上的设备时，设备被选中并高亮。

### 需求
- 鼠标左键点击设备 → 出现白色/黄色选中框
- 点击空白区域 → 取消选中
- 选中框跟随相机缩放/平移

### 验收标准（你在浏览器看到的效果）
- **（前提：AI 先放置几个设备用于测试）**
- **鼠标左键点击设备** → 设备周围出现白色选中框（矩形描边）
- **点击空白区域** → 选中框消失
- **选中状态下拖拽缩放** → 选中框跟随设备位置变化
- 框线清晰，不模糊

### 前瞻约束（为 Phase 2 长按移动预留）

Phase 2 的 T2.14 会给设备加上"长按进入移动态"的交互——**短按 = 选中（本任务），长按（>300ms）= 进入移动模式**。两者共用左键，因此本任务的点击选中实现必须满足以下约束，否则 Phase 2 要返工：

- **选中必须瞬时响应**：左键按下/抬起时立即选中，不能加任何人为延迟（也是基本 UX 要求）
- **用 pointerdown/pointerup 结构，而非 click 事件**：pointerdown 记录按下起始时间戳 + 命中的设备；pointerup 时判定为"短按 → 选中"。这样 Phase 2 只需在 pointerdown 后挂一个 300ms 定时器：定时器触发前 pointerup = 选中，定时器触发 = 升级为移动态，无需改动本任务的选中逻辑
- **不要在 pointerdown 就把后续事件吞掉**：避免在 pointerdown 立即 commit 选中并阻止后续 pointermove/pointerup，那会导致 Phase 2 无法叠加长按检测

> **一句话总结**：左键点设备 = 选中（瞬时、pointerup 提交），同时保留 pointerdown 的时间戳和命中设备，供 Phase 2 长按检测复用。

### 预估工时
1 次会话

---

## T1.8 — 设备放置系统

### 目标
从工具栏选择设备，放置到地图网格上；放置前可旋转朝向（相对视图）。

### 需求
- 底部显示工具栏，有 4 种设备图标按钮
- 点击按钮 → 鼠标变成半透明设备预览（跟随鼠标，吸附网格）
- 左键点击地图 → 设备放置到网格交叉点
- 右键或 ESC → 取消放置模式
- **放置前按 R 键** → 预览设备顺时针旋转 90°（0°→90°→180°→270°→0°），Port 朝向跟随
- 旋转后的 footprint 占位检查随之更新（3×3 等正方形占地不变，仅朝向/Port 变化）

> **R 键参考系约定（相对视图）**：A3 §3.3 的方向（0°=右）是世界相对定义，但玩家按 R 的手感是**屏幕相对**的——视图旋转后，按 R 让设备在屏幕上看起来转 90°。实现上：玩家按 R 时，设备的"屏幕显示朝向"加 90°，再换算回世界朝向存入 `BuildingComponent.direction`（世界朝向 = 屏幕朝向 − viewRotation）。Phase 2 的 T2.14 移动态旋转同理。详见 A6 Camera 的 `viewRotation`。

### 验收标准（你在浏览器看到的效果）
- **打开浏览器** → 底部看到一排按钮，上面有设备图标
- **点击一个设备按钮** → 鼠标位置出现半透明的设备轮廓
- **移动鼠标** → 预览轮廓吸附到最近的网格交叉点，一跳一跳地移动
- **按 R 键** → 预览设备顺时针旋转 90°，每次按键转一次，能转满一圈
- **左键点击** → 设备按当前朝向固定在地图上，显示为 SVG 绘制的图形
- **左键点另一个位置** → 第二个设备出现
- **右键 或 ESC** → 预览消失，退出放置模式
- **点击放置好的设备** → 出现选中框（上一任务的功能）
- 设备位置正好在网格交叉点上，不偏移

### 预估工时
2 次会话（UI 占主要时间）

---

## T1.9 — 设备删除

### 目标
删除已放置的设备，补齐设备生命周期的逆操作。

### 背景
T1.8 只做了"放置"。删除是放置的逆操作（`OccupancyMap.release` + `destroyEntity`），做完才算占位表生命周期闭环，避免 Phase 2 接生产逻辑时出现"删了实体但忘了 release cell"这类泄漏 bug。Phase 1 不实现建造成本（A3 §1 的 `buildCost` 是后期功能），所以"放错朝向 → 删除重建"零代价，删除足够覆盖 Phase 1 的试错需求。

> **交互约定**：删除统一走 `Delete` 键，**不用右键**。右键语义专留给"取消放置模式"（T1.8），两套语义不重叠。

### 需求
- 选中已放置的设备 → 按 `Delete` 键 → 设备销毁
- 销毁时释放占位：`OccupancyMap.release(footprint 内所有 Cell)`
- `destroyEntity(handle)` → RenderSystem 自动移除对应 Sprite
- 选中态清空，选中框消失
- 无选中时按 Delete → 无反应（不做任何事）

### 验收标准（你在浏览器看到的效果）
- **（前提：AI 先放置几个设备用于测试）**
- **选中一个设备 → 按 Delete** → 设备消失，原来占的格子空出来，能再次放置新设备
- **没选中任何设备 → 按 Delete** → 无反应
- 删除操作不影响相机平移、缩放、其他设备
- 多次删除后，`OccupancyMap` 状态一致，无占位泄漏（AI 通过调试钩子验证）

### 预估工时
0.5 次会话

---

## T1.10 — 性能基准测试

### 目标
测试 100 个静态设备同时显示时，游戏是否流畅。

### 验收标准（你在浏览器看到的效果）
- **AI 执行"一键生成 100 个设备"的测试命令**
- **画面出现 100 个设备**（随机分布在网格上）
- **左上角 FPS 数字**在 55~60 之间跳动
- **放大查看 5 个设备** → FPS 仍是 55~60
- **缩小到 100 个都可见** → FPS 不低于 55
- 画面不卡顿、不闪烁

---

## 开发节奏建议

```
第 1 周
  会话 1: T1.1 ECS 完善 + T1.2 相机系统
  会话 2: T1.3 SVG 资源管线 + T1.4 世界网格
  会话 3: T1.5 视图操作（边缘滚动 + Ctrl+R 视图旋转，改造 Camera）
  会话 4: T1.6 渲染系统（主体）

第 2 周
  会话 5: T1.6 渲染系统（视口剔除 + 旋转回归） + T1.7 基础交互
  会话 6: T1.8 设备放置系统（UI + 放置逻辑 + 放置前旋转，R 键相对视图）
  会话 7: T1.8 设备放置系统（完善 + 测试）
  会话 8: T1.9 设备删除
  会话 9: T1.10 性能基准 + 收尾
```

---

## Phase 1 完成时的可运行效果

- 浏览器打开 → **浅灰色背景（#E6E4E4）上的网格地面，四角有暗角效果，网格线在屏边渐隐透明**
- **鼠标中键拖拽** → 画面平滑平移
- **鼠标移到窗口边缘** → 画面向该方向持续平移（RTS 风格边缘滚动）
- **滚轮** → 画面以鼠标为中心缩放
- **Ctrl+R** → 整个视图顺时针旋转 90°，连按 4 次回到原状；旋转后 WASD/边缘滚动按屏幕相对工作
- **底部工具栏**有设备图标按钮 → 点击后鼠标变为半透明预览
- **按 R 键** → 放置预览顺时针旋转（屏幕相对），能转满一圈
- **点击地图** → 设备按当前朝向放置在网格交叉点上
- **点击已放置的设备** → 白色选中框出现
- **选中设备 + Delete** → 设备被删除，格子空出来
- **地图上有 100 个设备**时依然流畅（FPS ≥ 55）

---

## 不在 Phase 1 范围内的（明确排除）

- 传送带动画/物品移动 → Phase 2
- 机器生产逻辑 → Phase 2
- 敌人 AI / 塔防 → Phase 3
- 设备**移动**（长按拾取 / 拖拽搬迁）→ **Phase 2 (T2.14)**。移动也是**旋转已放置设备**的唯一入口（长按进入移动态 → R 键旋转 → 左键重放），两者绑死。Phase 1 不做移动，故 Phase 1 也不支持改变已放置设备的朝向；放错朝向靠 Delete 删除 + 重新放置解决（Phase 1 无建造成本，零代价）
- 框选 / 批量操作 / 复制粘贴 → **Phase 3**。依赖多选基础设施（X 键框选模式），并在 T2.14 单设备移动机制之上扩展为组操作：组移动（所有目标格同时空闲）、组旋转（绕枢轴转 90°，含传送带链方向重算）、组删除、复制粘贴（布局剪贴板）。复杂度高，尤其传送带入组后要处理 chainId 重建，放 Phase 3 独立做
- 存档/读档 → 后续
- 跨平台打包 → 后续
- 音效 / 粒子特效 → 后续

---

## 附录 A：PixiJS v8 踩坑记录

> T1.4 开发中遇到的三个 PixiJS v8 陷阱。T1.5/T1.6（渲染系统、选中框）涉及渲染管线，
> 开发前务必阅读，避免重复踩坑。每条都附了**正确的替代方案**。

### A.1 FillGradient 的 global space 坐标映射不可靠

**现象**：用 `FillGradient({ type:'radial', textureSpace:'global', ... })` 生成径向渐变，
无论怎么调 `innerRadius` / `colorStops`，渐变中心区域都被**错误压暗**（背景 #E6E4E4 亮度
应 ~230，实测被压到 154）。

**原因**：PixiJS v8 的 `buildRadialGradient` 在 global space 下的 transform 计算
（`m.scale(1/scale, 1/scale)` + translate）与文档描述不符，实际行为不可预测。

**替代方案**：用**原生 Canvas 2D `createRadialGradient`** 生成离屏 canvas，转成 `Texture` +
`Sprite` 使用。语义明确、100% 可控。见 `GridRenderer.makeGradientTexture()`。

### A.2 Sprite alpha mask 在纹理 resize 时崩溃（严重）

**现象**：用 `sprite.mask = maskSprite`（maskSprite 是带纹理的 Sprite）做 alpha mask。
当视口 resize、`rebuildStatic()` 销毁并重建 mask 纹理时，渲染崩溃：
```
BindGroup.ts:112 Uncaught TypeError: Cannot read properties of null (reading '0')
  at AlphaMaskPipe.execute → MaskFilter.inverse → BindGroup.getResource
```
页面卡死。最大化/还原浏览器窗口必现。

**原因**：`maskSprite.texture.destroy(true)` 销毁纹理后，PixiJS 的 AlphaMaskPipe 仍持有
该纹理的 GPU BindGroup 引用，下一次渲染读到 null 资源崩溃。

**替代方案**：**避免用 Sprite mask 实现边缘渐隐**。改为给网格线**分段绘制时直接按位置设
stroke alpha**（每条线分 N 段，每段算距中心的归一化距离设 alpha）。这样不需要任何 mask
对象，根除崩溃路径。普通 Sprite（非 mask）的纹理 destroy 是安全的，不受此问题影响。

### A.3 window.resize 事件与 PixiJS ResizePlugin 时序竞争

**现象**：浏览器最大化/还原后，网格中心偏移到画面一侧（如偏右），左/右侧出现大片空白。

**原因**：`window.addEventListener('resize', onResize)` 与 PixiJS 内部的 ResizePlugin
**存在时序竞争**——PixiJS 在 resize 时异步更新 `app.screen`，我的 onResize 可能读到
**旧的** `app.screen.width/height`，导致 camera/grid 的 viewport 停在旧尺寸，
`updateTransform` 用错误的视口中心算 position，画面错位。

**替代方案**：**移除 window.resize 监听，改为主循环里每帧轮询 `app.screen` 尺寸变化**：
```ts
app.ticker.add(() => {
  if (app.screen.width !== lastW || app.screen.height !== lastH) {
    lastW = app.screen.width; lastH = app.screen.height;
    camera.setViewport({ width: lastW, height: lastH });
    gridRenderer.setViewport({ width: lastW, height: lastH });
  }
  // ...
});
```
下一帧必然捕获到 PixiJS 更新后的新值，彻底消除时序问题。

---

> **签入**: Phase 1 每个任务完成后 commit，提交信息格式 `Phase 1.x: 简短描述`  
> **分支策略**: 直接在 master 开发（单人项目），不进 Phase 2 不做 tag
