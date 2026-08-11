# 传送带选中交互重做 + 酷炫选中视觉（修订版）

## 需求（用户澄清后）
1. **交互**：单击带身段 → 只高亮那一格；双击同一格 → 升级为整条链高亮。
2. **视觉**（核心澄清）：
   - **斜杠是屏幕常量**——不管怎么滚轮缩放，斜杠大小/方向恒定（锚定屏幕）。
   - 传送带的**黄色区域(#FFEF00) 是斜杠的遮罩**：黄色在哪，斜杠才在哪显示。
   - 选中带身外侧有 ~5px 白色边框。
   - 选中格不显示 pointer（pointer 逻辑不变，仅不渲染）。
3. **删除**（用户已确认「删当前所选」）：单格选中→Delete 删该段；整链选中→Delete 删整链。Shift+Delete 取消。
4. **转角传送带纳入范围**（修订：上一版排除转角，本版包含）。

## 核心数学（已验证）
Camera 对 worldContainer 的变换：`scale=zoom, rotation=-displayRotation, pivot=相机中心, position=视口中心`。
→ 一个 worldContainer 的子 Graphics 设 `scale=1/zoom + rotation=displayRotation + position=格子中心`，则其本地坐标 p 映射到屏幕 = `worldToScreen(格中心) + p`（zoom 与旋转完全抵消）。**即斜杠在本地坐标按固定 px 画，屏幕上永远等大等向**，且随格子平移。黄色遮罩（世界坐标，随带身缩放/旋转）通过 PixiJS StencilMask 在屏幕空间裁剪斜杠 → 自然支持转角（复用弧形几何，无需手算顶点）。

## 架构
- **白色边框**：世界坐标（随带身缩放，与 SVG 一致；"5px"为默认 zoom 标称值），由 BeltVectorRenderer 在选中段的 body 上加白底画出。
- **斜杠**：屏幕常量，由新 BeltSelectionRenderer 按段绘制（maskG=黄色形 + stripeG=屏幕常量斜线）。
- **pointer 隐藏**：BeltPointerRenderer 按选中态隐藏。
- **共享选中态** `BeltSelection`（Set<handle>）：SelectionSystem 每帧写，三个渲染器读。

## 文件改动

### 新增 `src/game/systems/belt/BeltSelection.ts`
`class BeltSelection { set(handles): void; has(h): boolean; clear(): void }`

### 新增 `src/game/render/BeltSelectionRenderer.ts`
每帧根据 BeltSelection 为每个选中段维护一个 `{ container, maskG, stripeG }`（Map diff，增删随选中变化）：
- `container` 挂 layer2Building（高 zIndex，盖在带身之上），position=格中心(世界)。
- `maskG`（黄色形，StencilMask 不显色）：transform 与带身 body 完全一致（直段 `beltTextureRotation(dir)`；转角 `beltCornerTransform`），画 `drawBeltYellowShape`。
- `stripeG`（屏幕常量斜杠）：每帧 `scale=1/zoom, rotation=displayRotation`；本地坐标画 45° 斜线（color 0xeec213，周期 ~8px，1:1，跨度 ±CELL_SIZE×3 覆盖高 zoom）；`stripeG.mask = maskG`。
- 空选中时隐藏整体。

### 改 `src/game/render/BeltVectorGeometry.ts`
- 新增 `drawBeltYellowShape(g, cellSize, isCorner)`：黄色区域形（直段=黄带 rect；转角=黄带弧环 circle5），供 maskG 用。
- 新增 `drawStraightBeltUnderlay(g, cellSize)` / `drawCornerBeltUnderlay(g, cellSize)`：白色底（直段 rect 宽=SHELL_W+2×RIM=14.2875；转角弧环 outer r=SHELL_R+RIM，已验算不溢出格角）。RIM=1.3229 viewBox 单位≈5px。

### 改 `src/game/render/BeltVectorRenderer.ts`
- shapeKey 加 `selected` 标志；选中时 bodyG 先画白底再画灰+黄（复用 underlay + 现有 drawStraightBelt/drawCornerBelt）。
- 读 BeltSelection（renderSystem 注入）。

### 改 `src/game/render/BeltPointerRenderer.ts`
- 每帧 `if (beltSelection?.has(handle)) entry.sprite.visible = false`（选中格隐藏 pointer）。

### 改 `src/game/systems/RenderSystem.ts`
- 构造 `BeltSelectionRenderer`（挂 layer2Building），update 中调用；新增 `setBeltSelection(bs)` 转发给三个带身渲染器。

### 改 `src/game/systems/SelectionSystem.ts`
- `SelectionTarget` belt 分支加 `wholeChain: boolean`。
- 双击检测：`lastBeltClick{handle,time}`，pointerup 短按命中带身：同 handle 且 <350ms → wholeChain=true；否则 wholeChain=false（记 lastBeltClick）。命中设备/空白清空。
- 构造加 `beltSelection`；`update()` 每帧重算 beltSelection（wholeChain→queryChain，单格→[handle]），**不再画 screen-space 带身高亮**（视觉移交 BeltSelectionRenderer）；`clearSelection()` 同步清 beltSelection。
- `getSelectedChain()` 返回加 `wholeChain`。

### 改 `src/main.ts`
- 创建 BeltSelection，传 SelectionSystem 构造 + `game.renderSystem.setBeltSelection(bs)`。
- `onKeyDelete`：`chain.wholeChain ? deleteChain : deleteSegment`（去 Shift 分支）。
- HUD：「传送带段 1段」/「传送带链 N段」。
- 钩子：`selectFirstBelt(doubleClick=false)`（double=true 连续两次短按选整链）、`deleteSelectedBelt()`（按 wholeChain 删）；更新 console help。

## 验收
- 单击段 → 仅该格：白边 + 黄底叠屏幕常量斜杠 + 无 pointer；滚轮缩放斜杠大小不变。
- 双击同格 → 整链所有段同上。
- 转角段：白弧边 + 黄弧底叠斜杠（mask 自动跟随弧形）。
- 单格+Delete → 该段删；整链+Delete → 整链删。
- 设备选中视觉不变。

## 假设（可后续微调）
- 白色边框为世界坐标（随带身缩放）；若要屏幕常量厚度再调。
- 斜杠周期 ~8px、1:1、#eec213；具体数值易调。
