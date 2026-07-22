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
| T1.5 渲染系统 | ⬜ 待开发 | 实体↔Sprite 绑定、视口剔除 |
| T1.6 基础交互系统 | ⬜ 待开发 | 点击选中、选中框 |
| T1.7 设备放置系统 | ⬜ 待开发 | 工具栏、放置预览、OccupancyMap |
| T1.8 性能基准测试 | ⬜ 待开发 | 100 设备 FPS ≥ 55 |

> **文档修订**: DD-008 已修订（设备 SVG / 物品 PNG 双格式，见 core-decisions.md）。  
> **PixiJS 踩坑**: 见文末 [附录 A：PixiJS v8 踩坑记录](#附录-a-pixijs-v8-踩坑记录)，T1.5/T1.6 开发前务必阅读。

---

## 依赖关系图

```
T1.1 ECS 完善 ──────────────────────┐
                                     │
T1.2 相机系统 ──────────────────────┤
                                     ├──→ T1.5 渲染系统 ──→ T1.6 交互 ──→ T1.7 放置
T1.3 SVG 资源管线 ──────────────────┤
                                     │
T1.4 世界网格 ──────────────────────┘
                                                          ↓
                                                    T1.8 性能基准
```

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

## T1.5 — 渲染系统

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

### 预估工时
1~2 次会话

---

## T1.6 — 基础交互系统

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

### 预估工时
1 次会话

---

## T1.7 — 设备放置系统

### 目标
从工具栏选择设备，放置到地图网格上。

### 需求
- 底部显示工具栏，有 4 种设备图标按钮
- 点击按钮 → 鼠标变成半透明设备预览（跟随鼠标，吸附网格）
- 左键点击地图 → 设备放置到网格交叉点
- 右键或 ESC → 取消放置模式

### 验收标准（你在浏览器看到的效果）
- **打开浏览器** → 底部看到一排按钮，上面有设备图标
- **点击一个设备按钮** → 鼠标位置出现半透明的设备轮廓
- **移动鼠标** → 预览轮廓吸附到最近的网格交叉点，一跳一跳地移动
- **左键点击** → 设备固定在地图上，显示为 SVG 绘制的图形
- **左键点另一个位置** → 第二个设备出现
- **右键 或 ESC** → 预览消失，退出放置模式
- **点击放置好的设备** → 出现选中框（上一任务的功能）
- 设备位置正好在网格交叉点上，不偏移

### 预估工时
2 次会话（UI 占主要时间）

---

## T1.8 — 性能基准测试

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
  会话 3: T1.5 渲染系统（主体）

第 2 周
  会话 4: T1.5 渲染系统（视口剔除） + T1.6 基础交互
  会话 5: T1.7 设备放置系统（UI + 放置逻辑）
  会话 6: T1.7 设备放置系统（完善 + 测试）
  会话 7: T1.8 性能基准 + 收尾
```

---

## Phase 1 完成时的可运行效果

- 浏览器打开 → **浅灰色背景（#E6E4E4）上的网格地面，四角有暗角效果，网格线在屏边渐隐透明**
- **鼠标中键拖拽** → 画面平滑平移
- **滚轮** → 画面以鼠标为中心缩放
- **底部工具栏**有设备图标按钮 → 点击后鼠标变为半透明预览
- **点击地图** → 设备放置在网格交叉点上
- **点击已放置的设备** → 白色选中框出现
- **地图上有 100 个设备**时依然流畅（FPS ≥ 55）

---

## 不在 Phase 1 范围内的（明确排除）

- 传送带动画/物品移动 → Phase 2
- 机器生产逻辑 → Phase 2
- 敌人 AI / 塔防 → Phase 3
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
