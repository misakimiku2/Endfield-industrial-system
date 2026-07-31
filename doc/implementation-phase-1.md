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
| T1.3 SVG/PNG 资源管线 | ✅ 完成 | `scripts/pack-assets.ts` / `AssetsLoader.ts`（三图集）。**优化①（放大锯齿）**：devices 图集 SVG 按 `DEVICE_RASTER_SCALE=4` 光栅化（匹配 `CAMERA_ZOOM_MAX=4.0`），zoom=4 时纹素:像素 1:1。**优化②（缩小锯齿）**：图集纹理源开 mipmap（`autoGenerateMipmaps`+`linear`+各向异性），消除 zoom<1 时的纹理采样锯齿；`ATLAS_PADDING` 2→8 抑制 mipmap 渗色 |
| T1.4 世界网格渲染 | ✅ 完成 | `GridRenderer.ts`（分段 alpha + Canvas2D 暗角） |
| T1.5 视图操作 | ✅ 完成 | 边缘滚动、Ctrl+R 视图旋转(屏幕相对参考系+平滑过渡)、`screenDirToWorld`/`panByScreen`、GridRenderer 旋转感知。**修正**：`rotateClockwise` 旋转目标重锚定到 `viewRotation` 离散精确值（`nextClockwiseTarget`），消除连旋漂移导致"转 4 次不回正"的 bug |
| T1.6 渲染系统 | ✅ 完成 | `RenderSystem`（query diff 实体↔Sprite 绑定、视口剔除、层映射）、`MapInstance`（WORLD_* 常量→地图实例属性，A11 WV-003 §4.4） |
| T1.7 设备放置系统 | ✅ 完成 | 核心闭环完成（工具栏选设备→左键放网格交叉点→R 键旋转预览→右键/ESC 取消）。`BuildingDefinition`(DD-003)、`BuildingComponent`(DD-002)、`OccupancyMap`(A2 §7)、`InventoryUI`(PixiJS Container 挂 overlayLayer)、`PlacementSystem`(鼠标=设备中心 + R 键相对视图换算/A6 §4.0)、`PreviewTintFilter`(双纹理 mask 方案：主体纯色 + 箭头白)。预览染色经 4 轮迭代已稳定；用户反馈的箭头方向、R 键旋转跟随问题已修复。设备 SVG 已按 `layer-*` 功能层规范化，`pack-assets.ts` 同步输出 `/base`、`/ports`、`/arrows`、`/indicators`、`/equipment` 子帧；精炼炉已叠加 logo 与液体输入/输出端口视觉，为 Phase 2 动态表现奠基。 |
| T1.8 基础交互系统 | ✅ 完成 | `SelectionSystem.ts`（pointerdown/pointerup 短按选中 + 屏幕空间白色选中框，跟随相机缩放/平移/旋转） |
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
                                     ├──→ T1.5 视图操作 ──→ T1.6 渲染系统 ──→ T1.7 放置 ──→ T1.8 交互 ──→ T1.9 设备删除
T1.3 SVG 资源管线 ──────────────────┤        (边缘滚动        (实体↔Sprite         (工具栏+       (选中)        (Delete键
                                     │       +Ctrl+R 视图        绑定)                放置预览)                    占位释放)
T1.4 世界网格 ──────────────────────┘        旋转, 改 Camera)                                                       │
                                                                                                                     ↓
                                                                                                               T1.10 性能基准
```

> **T1.5 为何排在 T1.6 渲染之前**：视图旋转（Ctrl+R）会改 Camera 变换，下游所有用 `worldToScreen`/`screenToWorld` 的系统（T1.6 渲染、T1.7 放置、T1.8 交互）必须一开始就建成"旋转感知"的，否则后面返工面大。T1.5 把 Camera 改造好，后续任务直接用。
> **T1.7 为何排在 T1.8 交互之前**：选中（T1.8）的语义对象是"设备"，而"设备"这个概念——`BuildingComponent` + `BuildingDefinition` + `OccupancyMap`——要到 T1.7 才建立。若先做选中，只能用 `SpriteComp` 凑合 hit-test（会把同样带 SpriteComp 的传送带/敌人一并选中），T1.7 引入 BuildingComponent 时还得回头改选中逻辑。放置先于选中，选中框直接 hit-test BuildingComponent 实体，零返工。
> **T1.9 依赖说明**：删除需要 `OccupancyMap.release`（T1.7 建）+ `destroyEntity`（T1.1 已完成）+ 选择态（T1.8）。
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
- **输入**: 中键拖拽（反向跟随）、WASD/方向键（帧率无关 900px/s）、滚轮（**target lerp 平滑缩放**：滚轮按 `deltaY` 线性比例累乘 `targetZoom`（`newTarget = targetZoom × (1 − deltaY/200)`，保留滚轮"力度"，触控板丝滑），显示 zoom 由 `update()` 每帧向 targetZoom 做帧率无关指数趋近（`k = 1 − exp(−dt/TAU)`，连滚不冻结、停手平滑追上无猛冲），全程以鼠标位置为固定世界锚点保证无漂移。参数见 `constants.ts` 的 `CAMERA_ZOOM_WHEEL_DELTA_DIVISOR`/`CAMERA_ZOOM_SMOOTH_TAU`/`CAMERA_ZOOM_SNAP_EPSILON`。注：`zoomAt`/`setZoom` 仍为瞬时语义，供 verify 脚本与未来 UI 按钮用，滚轮走独立的 `zoomByWheel(deltaY)` 路径）
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
- **图集产出**: devices(22块,4096×4096,SVG 按 4× 光栅化) / items(93块,4096×2048) / ui(28块,2048×256)。块数含 T1.7 的功能层子帧与箭头 mask 帧；尺寸为开 mipmap + padding=8 后的实际值。
- **图集上限 4096**: WebGL2 安全上限（原 2048 装不下 93 个 254px 物品图标）
- **SVG 光栅化倍率（`rasterScale`，解决放大锯齿）**: 地图设备随 zoom 放大显示，若按 1:1 原始尺寸栅格化（1×1 设备仅 64px 纹理），zoom=4 时被放大 4 倍会模糊锯齿。devices 图集 SVG 按 `DEVICE_RASTER_SCALE=4` 栅格化（`asset-manifest.ts`），匹配 `CAMERA_ZOOM_MAX=4.0`，保证最大缩放下纹素:屏幕像素 ≈ 1:1。1×1 设备纹理 64→256px、3×3 设备 192→768px。items（PNG 源，无矢量）/ ui（屏幕空间固定尺寸）不提倍。⚠️ 若 `CAMERA_ZOOM_MAX` 调高，`DEVICE_RASTER_SCALE` 需同步。T1.6 RenderSystem 用 `sprite.width=世界尺寸` 覆盖纹理尺寸，对分辨率变化透明，无需改。**注意**：光栅化倍率只解决 zoom>1（放大）的锯齿；zoom<1（缩小）的锯齿由 mipmap 解决（见下文"运行时纹理采样配置"），两者互补。
- **设备 SVG 功能层拆分（T1.7 收尾扩展）**: 设备 SVG 必须按 `layer-*` 功能层组织（详见 `doc/asset-drawing-standard.md`）。`pack-assets.ts` 会对每张设备 SVG 输出：
  - 完整设备帧 `<device_key>`（所有层可见，兼容现有单 Sprite 渲染）
  - 功能层子帧 `<device_key>/base`、`/ports`、`/arrows`、`/indicators`、`/equipment`
  - T1.7 预览用箭头 mask `<device_key>_arrow_mask`（兼容用）
  所有层子帧与完整帧 `sourceSize` 一致，运行时可直接叠加。`3x3_unit.svg` 已按标准重构为**通用 3×3 底座**，精炼炉专属 `layer-equipment` 独立到 `refining_unit.svg`。
- **texture key 映射**: 文件名→小写→非字母数字替 `_`；手工覆盖表（`3x3_unit→3x3_unit`、`refining_unit.svg→refining_unit` 等）
- **运行时纹理采样配置（mipmap，解决缩小锯齿）**: `AssetsLoader.loadAll()` 加载三图集时经 `data.textureOptions` 注入 mipmap 配置（`autoGenerateMipmaps:true`/`mipLevelCount:4`/`scaleMode:'linear'`/`maxAnisotropy:4`），透传给底层 ImageSource 在纹理**首次上传前**配好，GPU 上传时自动生成 mipmap 链。背景：PixiJS v8 默认 `autoGenerateMipmaps=false`、`mipLevelCount=1`，纹理在 zoom<1 缩小时会产生严重 aliasing（精炼炉 logo / 液体接口等高频细节尤其明显，越小越严重）；`antialias:true` 只对几何多边形边缘 MSAA 生效，对纹理采样缩小锯齿无效。⚠️ 副作用：atlas 子帧共享大图，低层级 mipmap 会渗色（bleeding），由 `ATLAS_PADDING=8` 抑制（见下条）。`getTexture(group, key)` 统一访问，纹理源配置自动继承。
- **图集 padding（`ATLAS_PADDING=8`，抑制 mipmap 渗色）**: 开 mipmap 后相邻图块在低层级 mipmap 会互相渗透（bleeding），padding 需随 mipmap level 递增。原 `2px` 在 level 1+ 即不足（缩小时图块边缘渗入邻居颜色），提升到 `8px`（level 1 等效 4px、level 2 等效 2px，配合子帧自身缩小，邻居渗透视觉可忽略）。改 padding 后需重跑 `npm run pack-assets`。
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
WASD 平移和滚轮缩放已在 T1.2 实现。边缘滚动是相机平移的便捷增强；视图旋转（类似 Factorio）则是一个**会级联影响下游所有系统**的改造——它改变 Camera 变换，因此 T1.6 渲染 / T1.7 放置 / T1.8 交互都必须从一开始就建成"旋转感知"的。本任务排在 T1.6 之前，正是为了把 Camera 改造好，后续任务直接消费。

> **参考系决策（已确认）**：
> - **WASD / 边缘滚动 → 屏幕相对**：无论视图怎么转，W 永远让画面向上平移、鼠标到屏幕上边永远向上滚（符合 RTS / Factorio 习惯）。
> - **R 键（设备放置/旋转）→ 相对视图**：视图转 90° 后按 R，设备在屏幕上看起来转 90°（即玩家面对屏幕操作）。详见 T1.7 放置章节。
>
> **为何都用屏幕相对/相对视图而非世界相对**：玩家操作的是屏幕上的画面，不是世界坐标系。屏幕相对在视图旋转后直觉一致，不会出现"按 W 画面却往右移"这种反直觉行为。

### 需求

**边缘滚动（Edge Scrolling）**
- 鼠标移到距窗口边缘 N px（默认 32px）的触发带内 → 画面向该方向自动平移
- 平移速度帧率无关，对齐 WASD 的 900px/s
- 到达世界边界时优雅停止（不抖动、不越界，复用 T1.2 的边界 clamp）
- 8 方向（上/下/左/右 + 四个对角）支持
- **与放置模式共存**：放置预览模式（T1.7）下鼠标到边缘，预览跟随平移后的画面移动（这是期望行为，方便往远处放设备）

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

### 实现说明（✅ 已完成）

**WORLD_* 常量 → 地图实例属性（A11 WV-003 §4.4，本任务前置改造）**：
- 新增 `src/game/world/MapInstance.ts`：世界尺寸（`widthCells/heightCells/widthPx/heightPx`）从全局常量下放为地图实例属性，`createDefaultMap()` 返回 64×64。
- 删除 `constants.ts` 的 `WORLD_WIDTH/HEIGHT_CELLS` 与 `WORLD_WIDTH/HEIGHT_PX`，仅保留 `WORLD_DEFAULT_CELLS`（默认地图尺寸来源）。`CELL_SIZE` 仍是常量。
- `Camera` 构造新增第二参数 `WorldBounds`（来自 `MapInstance`），`clampPosition`/初始定位改读 `this.bounds`；新增 `setWorldBounds()` 供 Phase 3a 切换世界尺寸。`getViewport()` 暴露只读视口供视口剔除。
- `WorldData` 持有 `map: MapInstance`（世界尺寸的唯一真相源）。
- 回归：`verify-t1.2`/`verify-t1.5` 改用 `createDefaultMap()` 派生 bounds（数值仍是 4096，断言不变）。

**RenderSystem（实体↔Sprite 绑定）**：
- 每帧 `world.query('Position','SpriteComp')`，diff 出新增/消失实体（A1 §5）：新增 → `new Sprite(texture)` 挂到对应层 Container；消失（`destroyEntity`/移组件）→ `sprite.destroy()` + 从父移除。覆盖 ecs-spec §4.3"销毁实体后由 RenderSystem 清理 PixiJS 对象"。
- 位置同步：Sprite 在 `worldContainer` 子层内，Camera 变换已承担平移/缩放/**旋转(T1.5)**，故实体只用世界坐标（左上角 + 半宽高居中），不绕开 Camera。
- 视口剔除：屏幕四角 world AABB + padding，屏外 Sprite 仅切 `visible=false`（不销毁），进出视口切换可见，避免反复 create/destroy。
- 纹理查找通过注入 `getTexture`（来自 AssetsLoader），便于单测 mock。
- `SpriteComp` 改为 `{ group, textureKey, logoTextureKey?, width, height, layer }` 对齐图集管线；`logoTextureKey` 用于 billboard 徽标层（T1.7 精炼炉）。
- `Game` 串联 ECS World + WorldData + Camera + RenderSystem；`main.ts` 主循环调 `game.update()`，并暴露 `__game.spawnTestDevices(n)` / `clearTestDevices()` 控制台钩子供验收。
- 验证脚本：`scripts/verify-t1.6.ts`（20 项断言：MapInstance、Camera bounds 回归、RenderSystem diff/层映射/视口剔除/纹理变更重建）。

---

## T1.7 — 设备放置系统

### 目标
从工具栏选择设备，放置到地图网格上；放置前可旋转朝向（相对视图）。本任务是 Phase 1 后半程的**地基任务**——它建立"设备"这个概念（`BuildingDefinition` + `BuildingComponent` + `OccupancyMap`），后续 T1.8 选中、T1.9 删除、T1.10 性能基准都建立在本任务产出的设备实体之上。

### 需求
- 底部显示工具栏，有 4 种设备图标按钮
- 点击按钮 → 鼠标变成半透明设备预览（跟随鼠标，吸附网格）
- 左键点击地图 → 设备放置到网格交叉点
- 右键或 ESC → 取消放置模式
- **放置前按 R 键** → 预览设备顺时针旋转 90°（0°→90°→180°→270°→0°），Port 朝向跟随
- 旋转后的 footprint 占位检查随之更新（3×3 等正方形占地不变，仅朝向/Port 变化）

> **工具栏技术选型（PixiJS Container，不用 DOM overlay）**：工具栏用 PixiJS Container 实现，挂在 `app.stage` 的屏幕空间层（`SceneRenderer` 的 UIOverlay 层序 6，A2 §4），**不要**挂到 `worldContainer`——这样它不随 Ctrl+R 视图旋转、不随相机平移/缩放，永远钉在屏幕底部。理由：(1) 与现有 HUD/help Text（`main.ts` 全部是 PixiJS `Text`）同栈，不引入第二套 DOM 渲染体系；(2) 图集已就绪，按钮图标直接 `getTexture('devices', '<设备key>')` 复用 T1.3 打包的纹理，无需为 DOM 单独存散图；(3) 输入走 PixiJS 事件系统（`eventMode:'static'` + `pointerdown`），与相机输入同一套 pointer 流，互斥好处理（点工具栏时 `stopPropagation` 抑制相机拖拽）。现有空壳 `src/game/ui/InventoryUI.ts` 即工具栏的落点（其 `// Phase 2 实现` 注释待 T1.7 改写）。DOM overlay 方案被排除：在有视图旋转 + 单画布架构下，DOM↔Canvas 坐标/缩放同步是新坑，得不偿失。

> **R 键参考系约定（相对视图）**：A3 §3.3 的方向（0°=右）是世界相对定义，但玩家按 R 的手感是**屏幕相对**的——视图旋转后，按 R 让设备在屏幕上看起来转 90°。实现上：玩家按 R 时，设备的"屏幕显示朝向"加 90°，再换算回世界朝向存入 `BuildingComponent.direction`（世界朝向 = 屏幕朝向 − viewRotation）。Phase 2 的 T2.14 移动态旋转同理。详见 A6 Camera 的 `viewRotation`。

### 验收标准（你在浏览器看到的效果）
- **打开浏览器** → 底部看到一排按钮，上面有设备图标
- **点击一个设备按钮** → 鼠标位置出现半透明的设备轮廓
- **移动鼠标** → 预览轮廓吸附到最近的网格交叉点，一跳一跳地移动
- **按 R 键** → 预览设备顺时针旋转 90°，每次按键转一次，能转满一圈
- **左键点击** → 设备按当前朝向固定在地图上，显示为 SVG 绘制的图形
- **左键点另一个位置** → 第二个设备出现
- **右键 或 ESC** → 预览消失，退出放置模式
- 设备位置正好在网格交叉点上，不偏移

### 预估工时
2 次会话（UI 占主要时间）

### ✅ 实现备注（已完成）

**产出文件**:
- `src/game/data/buildings.ts` — `BuildingDefinition` 数据表（DD-003 数据驱动）。严格按 A3 §1.1 建 7 个设备定义（refining/shredding/fitting/moulding/seed_picking/planting），Phase 2 生产字段（buildCost/powerConsumption/inputSlotCount/outputSlotCount/bufferCapacity）照填备用，Phase 1 只用 footprint/ports/texture/selectable。`TOOLBAR_BUILDINGS` 选 4 个（覆盖 3×3 + 5×5 footprint）。
- `src/game/components/BuildingComp.ts` — `BuildingComponent`（DD-002 纯数据）。**Phase 1 最小版**：只 `definitionId + direction + state('idle')`。缓冲区/计时/轮询指针等生产字段（A3 §3）不加，Phase 2 接生产逻辑时扩展。`Direction` 类型（0/90/180/270，世界相对存储 A3 §3.3）定义于此。
- `src/game/world/OccupancyMap.ts` — 占用表（A2 §7.1）。`Map<"gx,gy", definitionId>`。**边界严格读 `MapInstance`**（A11 WV-003 §4.4，T1.6 接口预留），`canPlace` 查 `[0,widthCells)×[0,heightCells)`，不读全局常量。提供 `occupyFootprint/releaseFootprint` 便利方法（后者 T1.9 删除用，本会话建好备用）。
- `src/game/ui/InventoryUI.ts` — **重写空壳**为工具栏。PixiJS Container，挂 `overlayLayer`（屏幕空间层 6），**不进 worldContainer** → 钉死屏幕底部，不受 Ctrl+R 旋转/相机平移影响。按钮 `eventMode:'static'` + `pointerdown` → onSelect 回调 + `stopPropagation`。占位图工厂（`PlaceholderTextureFactory`）对缺 SVG 设备用 Graphics 画 footprint 边框 + Port 标记 + 设备名首字 → `generateTexture` 缓存；补 SVG 后有纹理设备不再触发占位图。
- `src/game/systems/PlacementSystem.ts` — 放置预览 + 落盘系统。预览不进 ECS（UI 态），落盘才创建真实体。
- 改 `Game.ts`（持有 occupancy + placement）、`main.ts`（装配 InventoryUI + 输入转发 + 验收钩子）。

**R 键相对视图换算（A6 §4.0，本任务最易写错处）**:
- 核心策略：预览维护**屏幕呈现角 `screenAngle`(0/90/180/270)**，按 R 永远 `screenAngle = (screenAngle+90)%360`。**绝不直接对 `direction` 加 90**——防错根本。
- 关键统一：预览 Sprite 在 `layer2Building`（worldContainer 子层），其 rotation 是**世界空间**内的旋转，再被 camera 整体变换到屏幕。要在屏幕上呈现 screenAngle，预览 Sprite 的世界 rotation 必须 = `screenAngle − viewRotation`——这正是落盘时写入 `BuildingComponent.direction` 的同一公式（A6 §4.0：世界朝向 = 屏幕朝向 − viewRotation）。故预览渲染与落盘**共用同一世界角度**，无双轨，所见即所存。
- `sprite.rotation` 符号实测确认：`ROTATION_SIGN = +1`（`sprite.rotation = +worldAngle_rad`，PixiJS rotation 正值=屏幕顺时针）。浏览器实测：seed_picking_unit 占位图（input 蓝/output 橙标记）angle=0 时蓝在底，按 R 到 angle=90 时蓝移到左侧——**顺时针 90°**（底→左），符号正确。
- 落盘后真实体 Sprite **不旋转**（Phase 1 设备是静态贴图，A3 §2.4 明确 Phase 2 才接动态表现）。朝向信息存 `BuildingComponent.direction`，Phase 2 接视觉时 RenderSystem 读它旋转。本会话 RenderSystem 不改。

**snapToCell 行为（A2 §2.3）**: `Math.round(wx/CELL_SIZE)*CELL_SIZE`。JS `Math.round` 对 .5 向上取整，故 Cell 边界正中间（如 32px = 0.5 cell）吸附到**下一个 Cell**（64px）。0~31px→Cell 0，32~95px→Cell 1。不会出现"放一半"。

**修复的 bug（工具栏点击误放置）**:
- 现象：点击工具栏按钮选设备时，会在按钮对应的屏幕坐标处**误触发地图放置**（grid(30,35) 出现 refining_unit）。
- 根因：InventoryUI 按钮 pointerdown 调了 PixiJS 的 `stopPropagation`，但那只挡 PixiJS 事件系统内的冒泡；main.ts 的 `onPointerDownMain` 是加在 `app.canvas` 上的**原生 DOM 监听**，两者是独立事件流，stopPropagation 管不到。
- 修复：`onPointerDownMain` 用 `inventoryUI.container.getBounds()` 判断点击是否落在工具栏屏幕区域内，若是则不转发给 placement（让 InventoryUI 的 PixiJS 事件处理按钮选中）。

**R 与 Ctrl+R 冲突处理（用户强调）**:
- CameraController 已在 onKeyDown 拦截 `Ctrl/Cmd+KeyR`（视图旋转），裸 KeyR 不触发视图旋转。
- T1.7 的 R 监听由 main.ts **额外**加一个 window keydown 监听（`onKeyPlacing`），**只在 placing 态响应**裸 KeyR + Escape。两个监听并存不冲突。
- 实测：placing 态连按 4 次裸 R，screenAngle 转一圈回 0，camera.viewRotation 始终为 0——裸 R 不误触发视图旋转。

**相对视图换算语义实测（A6 §4.0）**: viewRot=90 时按 R：
- screenAngle 0→90，worldDir = (90−90)%360 = 0
- screenAngle 90→180，worldDir = (180−90)%360 = 90
- 每次按 R 世界朝向都 +90（mod 360），与不转视图时按 R 效果一致。A6 §4.0"世界朝向不变"指 Ctrl+R 视图旋转不改变已放置设备的世界朝向，非指按 R 不改变。

**输入转发架构**: PlacementSystem 不直接监听 DOM（避免与 CameraController 双监听冲突），由 main.ts 统一转发：`pointermove`→`setMouse`、`pointerdown`→`onPointerDown`、`keydown`→`onKeyDown`。

**验收钩子**: `__game` 新增 `placement`/`occupancy`/`inventoryUI`/`placeAt(defId,gx,gy,dir?)`/`getOccupiedCells()`/`clearAllPlaced()`。保留 T1.6 的 `spawnTestDevices`（不冲突，SpriteComp 测试用）。

**验证**:
- 纯逻辑：`verify-t1.7.ts` 137/137 通过（OccupancyMap 边界/footprint/正方形占地旋转不变、snapToCell、R 键换算 16 组合全表、screenAngle 递增、放置落盘三组件、边界外/冲突拒绝）。
- 浏览器实测：8 条验收标准全过——工具栏 4 按钮（refining 真实纹理 + 3 占位图）、点击进 placing、预览跟随吸附网格、R 顺时针旋转（符号实测确认）、左键放置、连放第二个、右键/ESC 取消、网格交叉点精确对齐（pos%64=0）。
- `tsc --noEmit` 零错误，`vite build` 成功，T1.6 verify 回归 20/20 通过。

**已知张力点 / 留给后续**:
- **缺 SVG 设备的正式美术**：shredding/fitting/moulding/seed_picking/planting 用占位图。补 SVG 是独立的 T1.3 收尾任务（重跑 pack-assets，definition texture key 不变，零代码改）。
- **BuildingComponent 待扩生产字段**：Phase 2 接生产逻辑时加 BufferSlot/currentRecipeId/progress/elapsed/bufferInput/bufferOutput/inputPollIndex/outputPollIndex（A3 §3）。
- **鼠标在工具栏上时预览仍跟随**：pointermove 不排除工具栏区域。视觉上预览可能显示在工具栏下方，不影响正确性。若需优化，pointermove 加工具栏区域排除（setMouse inside=false）。

### ✅ 后续修复（用户反馈 4 项）

T1.7 初版验收后，用户实测发现 4 个体验问题，已修复：

1. **鼠标=设备中心吸附（修复"设备出现在鼠标右下角"）**:
   - 原 bug：`worldToCell(mouseWorld)` 把鼠标位置当作设备**左上角** Cell 参考，导致设备整体在鼠标右下方。
   - 修复：新增 `placementFromMouse(mouseWorld, w, h)`，以**鼠标位置为设备中心**回推 footprint 左上角（`topLeft = mouseWorld − halfFootprint`，再吸附网格）。预览与落盘共用此算法，鼠标落在设备覆盖范围内。
   - 奇数 footprint（3×3/5×5）中心恰在某 Cell 中心；偶数 footprint 中心在四 Cell 交点。
2. **预览配色改为蓝/橙红**:
   - 原 `TINT_VALID=0xccffcc`（淡绿）/`TINT_INVALID=0xff9999`（淡红）→ 改为 `0x76bbea`（蓝）/`0xff8233`（橙红），整个预览染此色（tint）。
3. **预览浮在已放置设备之上**:
   - 预览与已放置设备同在 layer2Building，后创建的真实体会盖住预览。
   - 修复：预览 Sprite 设 `zIndex=10000`（layer2Building 已开 sortableChildren），始终浮在最上层。
4. **已放置设备保持旋转（修复"落盘后变正"）**:
   - 原 bug：RenderSystem 不读 `BuildingComp.direction`，真实体 Sprite 永不旋转（Phase 1 原计划设备静态）。
   - 修复：RenderSystem 每帧对带 BuildingComp 的实体按 `direction` 设 `sprite.rotation = direction_rad`（正值=屏幕顺时针，与预览 ROTATION_SIGN 同符号）。落盘设备的视觉朝向与放置预览一致。
   - T1.7 还增加了 billboard 徽标层：若 `SpriteComp.logoTextureKey` 存在，RenderSystem 会叠加一个子 Sprite，并每帧按 `camera.displayRotation - sprite.rotation` 反向旋转，使徽标在视图/设备旋转时保持屏幕朝上。
   - 此修复提前实现了原计划 Phase 2 的"RenderSystem 读 direction"（A3 §2.4 的主体旋转部分），Phase 2 接动态端口表现时在此基础上扩展。

验证：verify-t1.7 新增 E2 节（placementFromMouse 中心吸附 8 断言），共 145/145 通过；浏览器实测 4 项修复全部视觉确认。

### ✅ 预览染色 Filter 演进（用户需求："设备整体变蓝、端口箭头变白"）

T1.7 预览染色是本任务反复迭代最多、坑最深的环节。用户最终需求明确为：**创建预览时设备主体整体变蓝（可放置）/橙红（不可放置），端口箭头单独变白；放置后设备还原原始外观**。经历了多轮方案迭代，下表记录演进脉络与每版的坑，供后续维护参考：

| 版本 | 方案 | 结果 / 问题 |
|------|------|------|
| v1 | `Sprite.tint` 乘法染色 | 黑色×蓝色=黑色，灰阶设备暗部染不上 |
| v2 | `ColorMatrixFilter` 亮度→颜色梯度（黑→深蓝、白→淡蓝） | 保留了设备明暗结构呈梯度蓝，但箭头被一起染成中等蓝，无法单独变白 |
| v3 | 自定义 `Filter` 按颜色距离识别 `#828080` 像素→白 + smoothstep 平滑 | 端口灰色元素抗锯齿交界中点（如 `#202020↔#cbc9c9` 交界 `#767575`）距 `#828080` 仅 0.08，被误判为箭头→端口出现白色缝隙。**这是灰度空间插值的数学必然，调阈值无法两全** |
| **v4（当前）** | **双纹理 mask 方案** | ✅ 彻底解决。构建期矢量层分离箭头生成 mask 纹理，运行时双纹理采样，不依赖颜色识别 |

**v4 当前方案（`PreviewTintFilter` 双纹理 mask）**：

核心思路：不靠颜色识别箭头（端口灰色交界必然复现 `#828080`，死路），改为**构建期在矢量层精确分离箭头**，运行时用第二张 mask 纹理指示箭头位置。

- **构建期**（`pack-assets.ts`）：新增 `buildArrowMaskSvg()` 用正则 `/<path\b(?=[^>]*fill:\s*none)(?=[^>]*stroke:\s*#828080)[^>]*\/>/g` 精确提取 6 个箭头 path（`fill:none`+`stroke:#828080` 双条件，无误伤连接器柱 `fill:#828080`），stroke 改白，拼上原 SVG 头部（保留 `width/height/viewBox` 保证尺寸一致）重建精简 SVG → 光栅化成 `${baseKey}_arrow_mask` 帧打包进 devices 图集。mask 帧与设备帧 sourceSize 完全一致（768×768）。
- **运行时**（`PreviewTintFilter`）：双纹理 `Filter`。`uTexture`（设备原图）染主体纯色（蓝 `#76BBEA`/橙红 `#FF8233`）；`uMaskTexture`（箭头 mask，整个图集 source）经 UV 变换后采样，`R` 通道作箭头权重→白。

**双纹理 + spritesheet UV 变换的三个关键坑（均已解决，记录防回归）**：

1. **`uTexture` 是 render-target 而非图集纹理**：filter 系统把 sprite 先画进一个借自 `TexturePool` 的独立 render-target，再采样它。故 `vTextureCoord` 是 render-target 内坐标（范围 `[0, bounds/po2]`，非图集 UV 也非 0~1）。`uMaskTexture` 绑定的是整个图集 source（4096×1024），直接 `texture(uMaskTexture, vTextureCoord)` 会采样错位→颜色错乱。修复：shader 用 filter 内置 uniform `uOutputFrame`/`uInputSize` 还原设备局部 `[0,1]`，再用 `uMaskUvRect`（mask 帧在图集的 UV rect）映射采样。
2. **GLSL 精度冲突**：声明 `uInputSize`/`uOutputFrame` 时若不显式加 `highp`，PixiJS 给 vertex 注入 `highp`、fragment 注入 `mediump`→同名 uniform 精度不一致→shader 编译失败（`Could not initialize shader`）→预览完全不显示。修复：fragment 声明加 `uniform highp vec4 uInputSize`。
3. **Y 轴翻转**：设备图经 render-target 渲染后 Y 翻转，而 mask 的 `Texture.uvs` 是图集原始 UV（未翻转）。直接映射会导致箭头上下错乱、聚集到下方中间。修复：mask UV 的 Y 用 `1.0 - local01.y` 翻转抵消。

**其它配套改动**：
- `setMask(maskTexture)` 从 `Texture.uvs` 对象（`{x0,y0,...,x3,y3}`，**注意是对象非数组**）读取 UV rect 注入 `maskUniforms.uMaskUvRect`，自动适配图集重排/rotate/trim。
- `defaultFilterVertex.ts`（新增）：内联 PixiJS v8 filter 默认 vertex shader（官方未公开导出，自定义 filter 复用）。
- `PlacementSystem.refreshPreview` 换纹理时同步 `setMask(getTexture('devices', '${texture}_arrow_mask'))`。
- SVG `3x3_unit.svg` 保持原始状态（连接器柱与箭头都用 `#828080`）——mask 方案不依赖颜色区分，放置后设备保持原始外观。

**验证方法学**：定位坑 1/3 时用了**调试 shader**（把坐标/采样值编码成颜色输出），比盲目猜测高效：先确认 `local01` 是正确的 `[0,1]` 渐变，再确认 Y 翻转后 mask 输出 6 个分散箭头。

### ✅ 用户反馈收尾（已修复）

T1.7 初版验收后，用户针对预览染色与素材组织提出 3 个追加问题，均已修复：

1. **箭头方向反了**  
   原 shader 中 mask UV 的 Y 轴多了一次 `1.0 - local01.y` 翻转，导致原 SVG 中朝上的箭头在预览里朝下。修复：移除该翻转，直接按 `local01` 采样 mask。

2. **按 R 旋转时箭头不跟随**  
   原 `PreviewTintFilter` 没有同步预览 Sprite 的 `rotation`，mask 始终按 0° 采样。修复：新增 `uRotation` uniform + `setRotation()` 接口，在 `PlacementSystem.refreshPreview` 每帧把 `preview.rotation` 同步给 filter；同时把 filter `padding` 设为 `0`，避免输出帧外扩导致 mask 缩放错位。

3. **SVG 分层不规范**  
   原 `3x3_unit.svg` 的图层按网格位置命名（`layer_2_1` 等），每个位置组内混合了底盘、面板、箭头，无法按功能拆分。修复：重构成 `layer-base` / `layer-ports` / `layer-arrows` / `layer-indicators` 功能层，并扩展 `pack-assets.ts` 输出各层子帧。详见下节。

### ✅ SVG 功能层规范化与素材管线扩展

为支持 Phase 2 "设备接入传送带后端口/指示灯状态变化"，T1.7 提前把设备 SVG 从"单张大图"演进为"功能层组合"。

**规范来源**: `doc/asset-drawing-standard.md`

**通用底座 `3x3_unit.svg` 重构结果**:
- `layer-base`: 底盘、边框、占位框（所有 3×3 设备可复用）
- `layer-ports`: 6 个端口面板（`rect_mid_*` / `rect_top_*`）
- `layer-arrows`: 6 个端口方向箭头
- `layer-indicators`: 空层，供 Phase 2 状态指示灯使用

**精炼炉专用 SVG `refining_unit.svg` 结构**:
- 完整复制 `3x3_unit.svg` 的底座/端口/箭头/指示灯层
- 新增 `layer-equipment`，放置精炼炉专属**液体输入/输出端口**
- 新增 `layer-logo`，放置精炼炉**中央徽标**（billboard，保持屏幕朝上）

**T1.7 收尾：精炼炉专属视觉元素**:

在通用 3×3 底座基础上叠加：

1. **中央 logo**（`layer-logo`，使用 `src/assets/svg/LOGO/Refining_Unit_Logo.svg`）
   - 正常大小 logo 居中放置
   - 在其下方（z 轴下层）叠加一个放大 1.5 倍、透明度 0.3 的同 logo，形成背景光晕/阴影效果
   - 该层默认 `display:none`，完整设备帧中不包含 logo；运行时会作为 billboard 子 Sprite 单独叠加，并在旋转（Ctrl+R / R）时保持屏幕朝上
2. **左侧液体输出端口**（`layer-equipment`，使用 `src/assets/svg/liquid_export.svg`），距离左边缘 7px
3. **右侧液体输入端口**（`layer-equipment`，使用 `src/assets/svg/liquid_import.svg`），距离右边缘 7px

**构建输出**（`npm run pack-assets` 后 devices 图集新增）:
| key | 内容 |
|-----|------|
| `refining_unit.png` | 完整设备主体（不含 logo） |
| `refining_unit/base.png` | 仅底盘/边框/占位框 |
| `refining_unit/ports.png` | 仅端口面板 |
| `refining_unit/arrows.png` | 仅箭头 |
| `refining_unit/indicators.png` | 空层占位 |
| `refining_unit/equipment.png` | 液体输入/输出端口 |
| `refining_unit/logo.png` | 精炼炉徽标（billboard） |
| `refining_unit_arrow_mask.png` | T1.7 预览 mask（兼容用，未来可迁移到 `/arrows`） |

所有层子帧 `sourceSize` 与完整帧一致（768×768），PixiJS 中可直接按同一 `width/height` 叠加。

**对 T1.7 预览的影响**: `refining_unit_arrow_mask.png` 仍然保留，当前 `PreviewTintFilter` 继续使用它；`refining_unit/arrows.png` 作为新规范产物，供 Phase 2 组合渲染使用。

### ⚠️ 剩余遗留项

- **工具栏高亮 activeBtn**：`setActive` 本身正常，但按钮点击后高亮链路待排查（main.ts onSelect 闭包 / InventoryUI 事件链路）。
- **`placementFromMouse` 用 round 吸附**：奇数 footprint（3×3/5×5）的几何中心天然落在格子中心，网格吸附锚定在格子顶点，二者差半格——这是网格吸附的固有特性。当前用 `round`（向最近取整）使偏移对称化，不再系统性偏左上，但鼠标恰在格点边界时设备中心仍可能偏移半格。若用户对"鼠标=设备精确中心"有更高要求，需评估是否脱离网格自由放置（会破坏网格对齐规则）。
- **占位图设备无 mask**：shredding/fitting/seed_picking 等用程序化占位图（`PlaceholderTextureFactory`），没有对应的 `_arrow_mask` 帧，预览时这些设备的箭头权重恒为 0（不显示白色箭头）。补正式 SVG 后 pack-assets 自动生成 mask。

---

## T1.8 — 基础交互系统

### 目标
点击地图上的设备时，设备被选中并高亮。

### 需求
- 鼠标左键点击设备 → 出现白色/黄色选中框
- 点击空白区域 → 取消选中
- 选中框跟随相机缩放/平移

### 验收标准（你在浏览器看到的效果）
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

### ✅ 实现备注（已完成）
- **产出文件**: `src/game/systems/SelectionSystem.ts`（新）、`scripts/verify-t1.8.ts`（新）、`src/main.ts`（输入转发 + 验收钩子）
- **交互结构（前瞻约束逐条落实）**:
  - pointerdown → 只记录按下时间戳 + 命中设备，**不 commit、不 preventDefault/stopPropagation**（Phase 2 长按检测可直接叠加）
  - pointerup → 判定短按（<300ms）：命中设备=选中、命中空白=取消；长按（≥300ms）Phase 1 无移动语义，不改变选中态——Phase 2 只需在 pointerdown 后挂 300ms 定时器接管为移动态，无需改动本任务逻辑
- **命中测试**: 遍历 `Position+SpriteComp+BuildingComp` 实体，footprint 世界 AABB 点包含（Phase 1 footprint 全正方形，旋转不改变 AABB，A3 §6）；尊重 `BuildingDefinition.selectable`（A3 §1，Phase 1 全 true）；非 BuildingComp 的 Sprite 实体（传送带/敌人/测试 Sprite）天然不参与选中
- **选中框渲染**: 屏幕空间 `Graphics` 挂 `overlayLayer`（zIndex −10，工具栏之下）；每帧用 `worldToScreen` 求 footprint 四角 → **纯白 4px 矩形描边**（用户要求加粗并去掉黑色外描边）；线宽恒定屏幕像素，不随 zoom 变粗/变细；顶点像素取整避免半像素发糊；视图旋转下画旋转四边形，跟随相机平移/缩放/旋转过渡动画（worldToScreen 用 displayRotation）
- **输入接线**: main.ts 非放置态左键 pointerdown/pointerup 转发；放置态点击不进选中逻辑；工具栏包围盒排除（与 T1.7 同机制）；中键拖拽/右键不受影响
- **验证**: `scripts/verify-t1.8.ts` → 33 条断言全通过（命中/状态机/长按预留/投影几何/Graphics 生命周期）；`tsc --noEmit` 零错误；`npm run build` 通过
- **浏览器验收钩子**: `__game.placeAt("refining_unit",5,5)` 放设备 → `__game.selectFirstBuilding()` 选中 → `selection.getSelected()` 查询；HUD 显示"选中=设备"
- **浏览器复测（agent-browser）**: 真实鼠标点击/中键拖拽/滚轮缩放/视图旋转/DPR 1~2/1280×720 与 1920×1080 下，选中框每帧经 `worldToScreen` 重算，均精确跟随设备（像素级验证，画面顶部无残留白色矩形）。防御性修正: 顶点非有限值时隐藏选中框并告警；HUD 增加 `选中=设备@(x,y)` 实时屏幕坐标，便于排查"选中框钉住不动"类问题
- **Bug 修复（点空白后选中框"印在画布上"）**: 根因是 pointerup 点空白只置 `selected=null`，未隐藏/清除 Graphics，而 `update()` 对 null 直接 return——最后一张几何永远留在 overlayLayer，位置大小冻结在点击时刻。修复: 取消选中路径统一走 `hideBox()`（隐藏 + clear + 清 lastBoxTopLeft），`update()` 对 null 兜底隐藏；新增回归断言（点空白后 graphics 立即隐藏、update 不复活），verify-t1.8 现 37 项全通过

### ⚠️ 剩余遗留项
- **长按（≥300ms）在 Phase 1 不产生任何效果**（不选中也不移动）：这是为 T2.14 预留的语义——长按 = 移动态。若想在 Phase 1 长按也选中，需在 T2.14 前回退调整此判定
- **命中用 footprint AABB**：设备纹理透明边角也算命中（网格游戏标准语义）；Phase 1 footprint 全正方形，引入非正方形 footprint 时命中与选中框需按 direction 旋转多边形
- **选中框为纯白 4px 线**：浅灰地面 (#E6E4E4) 上对比度足够；若将来地图换更浅/白色底色，需重新评估描边可见性（可临时加外描边或改色，但用户当前明确不要黑边）

---

## T1.9 — 设备删除

### 目标
删除已放置的设备，补齐设备生命周期的逆操作。

### 背景
T1.7 只做了"放置"。删除是放置的逆操作（`OccupancyMap.release` + `destroyEntity`），做完才算占位表生命周期闭环，避免 Phase 2 接生产逻辑时出现"删了实体但忘了 release cell"这类泄漏 bug。Phase 1 不实现建造成本（A3 §1 的 `buildCost` 是后期功能），所以"放错朝向 → 删除重建"零代价，删除足够覆盖 Phase 1 的试错需求。

> **交互约定**：删除统一走 `Delete` 键，**不用右键**。右键语义专留给"取消放置模式"（T1.7），两套语义不重叠。

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
  会话 5: T1.6 渲染系统（视口剔除 + 旋转回归） + T1.7 设备放置系统（UI 工具栏 + 放置逻辑 + 放置前旋转，R 键相对视图）
  会话 6: T1.7 设备放置系统（完善 + 测试）
  会话 7: T1.8 基础交互（点击选中 + 选中框）
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

> T1.4 开发中遇到的三个 PixiJS v8 陷阱。T1.5/T1.6/T1.8（渲染系统、选中框）涉及渲染管线，
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
