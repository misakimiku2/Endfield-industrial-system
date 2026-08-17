# 九宫格设备底座方案（Nine-Slice Device Base）

> **编号**: S2（素材/渲染方案，S1 asset-drawing-standard.md 的姊妹篇）
> **状态**: ✅ 方案已批准，待实施（任务编号 T1.11，见 implementation-phase-1.md）
> **Phase 归属**: 🔵 Phase 1 补充任务（渲染/素材管线基建，不依赖 Phase 2 生产逻辑）
> **依据**: [S1 asset-drawing-standard.md](asset-drawing-standard.md)、[A3 building-spec.md](architecture/building-spec.md) §2.4（SVG 功能层）、implementation-phase-1.md T1.3/T1.6/T1.7
> **提出背景**: 2026-08-18 T2.8 开发期间 devices 图集 37 帧顶满 4096² → 临时扩容 8192。讨论设备尺寸增长（6×6 等）时图集面积 ∝ n² 爆炸的问题，用户提出九宫格平铺方案。经与素材实际结构（3x3_unit.svg 本就按 `base-pos-{r}-{c}` 分块绘制）核对，方案成立且是三种路线（扩容 / trim / 九宫格）中收益最大者。

---

## 0. 一句话

设备底座不再按"整机一张图"打包，改为**切 9 块小图（角/边/中）运行时按 footprint 平铺拼装**——图集面积与设备尺寸彻底解耦，任意 n×m 设备共用一套底座件，新增尺寸零美术成本。

---

## 1. 背景与动机

### 1.1 现状与问题

当前设备渲染走"整图 + 全画布层帧"模式（T1.3/T1.7 建立）：

- 每台设备一张整机帧（3×3 = 192px 源 × 4 超采样 = **768×768**）
- 每个功能层（端口面板、箭头、logo…）各一帧，**均为全画布占位**（为与主帧逐像素对齐）
- T2.8 后精炼炉一套 = 主帧 + 13 层帧 ≈ 8.3M 像素，其中**约 95% 是透明占位**

增长公式：n×n 设备帧边长 = 64n × 4 = 256n，**帧面积 ∝ n²**：

| 设备 | 栅格化帧 | 主帧面积 | 全套层帧（按精炼炉规模） |
|------|---------|---------|------------------------|
| 3×3（现状） | 768² | 0.59M | ~8.3M |
| 5×5（采种机，已有定义无素材） | 1280² | 1.64M | ~23M |
| 6×6 | 1536² | 2.36M | ~45M |

8192² 图集总容量 67M——**一台 6×6 设备吃掉 2/3，两台就爆**。且端口面板、箭头等小件的实际大小与设备尺寸无关，大设备上它们占的画布全是透明浪费。

### 1.2 三条路线对比

| 路线 | 效果 | 成本 | 结论 |
|------|------|------|------|
| ① 继续扩容（8192→16384） | 治标，两台 6×6 依旧爆 | 零 | 仅作临时（已做） |
| ② Trim 打包（裁透明边距） | 层帧面积与内容成正比，浪费清零 | 改 pack-assets + 帧偏移元数据 | **作为配套子任务并入本方案**（equipment/logo 层仍需要） |
| ③ **九宫格平铺（本方案）** | 底座面积与设备尺寸**彻底解耦**，一套件服务任意 n×m | 素材重切 + 打包切片提取 + 运行时拼装器 | **主体方案** |

### 1.3 为什么说"素材天然支持"

3x3_unit.svg 的 base 层本来就是分块绘制的：

- **9 块底板**：`base-pos-{行}-{列}`，每块 12.96×10.79 圆角板，板间留缝（互不连续）
- **4 根连接柱**（`emblazon_*`）：钉在内部竖格线与上下外框的交界
- **1 圈外框**（`border`）：整图 path——**唯一需要拆解的元素**（改为四角+四边分段归属）
- 端口面板/箭头：与尺寸无关的独立小件（T2.8 已是逐端口帧）

九宫格只是把"素材里已经分块"的事实，变成"打包与渲染也按块走"。

---

## 2. 方案总览

### 2.1 九宫格切分（用户编号约定）

```
1(左上 tl)  2(上中 t)  3(右上 tr)
4(左中 l)   5(中心 c)  6(右中 r)
7(左下 bl)  8(下中 b)  9(右下 br)
```

| 切片 | 内容（含边框/柱子归属） |
|------|------------------------|
| tl / tr / bl / br（角） | 1 块底板 + 两条正交外边框（各半宽，拼合后成整宽） |
| t / b（上下边） | 1 块底板 + 一条外边框 + **左右端各按规则配柱子**（见 §3.3） |
| l / r（左右边） | 1 块底板 + 一条外边框（无柱子——原素材柱子只钉竖格线，横向平铺由 t/b 承担） |
| c（中心） | 1 块底板，四边设计成可无限平铺 |

### 2.2 平铺展开规则（w×h 设备）

```
行 0（顶）:   tl, t × (w-2), tr
行 1..h-2:    l,  c × (w-2), r    ← 竖向重复 (h-2) 次
行 h-1（底）: bl, b × (w-2), br
```

示例（用户原话的对应）：

- **6×3**：横向 `1-2-2-2-2-3`，三行依次为顶行 / 中行 `4-5-5-5-5-6` / 底行 `7-8-8-8-8-9`
- **6×6**：4 角 + 上下边各 4 块 + 左右边各 4 块 + 中心 4×4 = 36 块，全部复用 9 件
- **3×3**：恰好 9 块 = 原画布布局（**像素级还原现状**，作为迁移验收基准）

切片总数恒为 w×h 块，但**纹理种类恒为 9 种**——图集占用固定 ~0.6M（9 × 256×256），与设备尺寸无关。

### 2.3 适用边界

| 设备形态 | 走什么 |
|---------|--------|
| w ≥ 2 且 h ≥ 2 | 九宫格（本方案） |
| w = 1 或 h = 1（1×1、3×1 仓库） | **整图**（现管线不动；Depot 3×1 已有整图素材，不迁移） |
| equipment 装饰层 / logo / 端口面板 / 箭头 | 独立小帧（现管线 + trim，见 §4.3） |

> 单行/单列设备理论上可做"三宫格"退化，但收益小（3×1 整图仅 0.59M）、特例逻辑多，v1 明确排除。

---

## 3. 素材规范（扩展 S1）

### 3.1 源文件

新增 `src/assets/svg/nineslice_unit.svg`：

- 画布 **3×3 格**（width/height = 192px，viewBox `0 0 50.799999 50.8`，与 3x3_unit.svg 同规格）
- 内容按 9 个切片组组织：`<g id="slice-tl">` … `<g id="slice-br">`（**命名用英文方位缩写**，与用户 1-9 编号的对应见 §2.1）
- 每组内容必须画在自己对应的 64px（16.93 SVG 单位）格子内

### 3.2 切片命名与键名

| 切片组 id | 纹理 key（devices 图集） |
|-----------|------------------------|
| slice-tl / slice-t / slice-tr | nineslice/tl、nineslice/t、nineslice/tr |
| slice-l / slice-c / slice-r | nineslice/l、nineslice/c、nineslice/r |
| slice-bl / slice-b / slice-br | nineslice/bl、nineslice/b、nineslice/br |

（沿用 pack-assets 的 `key/子键` 约定，与 `refining_unit/port-in-1` 同风格。）

### 3.3 绘制细则（平铺连续性是硬约束）

1. **可平铺性**：c 块四边、t/b 块上下边以外的左右衔接、l/r 块的纵向衔接，像素必须连续——平铺 N 份不得出现接缝/错位。验收方式见 §8。
2. **外边框分段**：border 拆为角块带"两条半宽边框"（相邻角/边块拼合成整宽），边块带一条整宽边框。
3. **柱子（emblazon）归属**：t/b 块**左端**画完整柱子（紧贴切片左缘、跨在将来的内部格线上），平铺后每条内部竖格线上下端各出一根——与原素材"每条内部竖格线端部有柱"的视觉一致；角块无柱子；w=3 时 t×1 恰好一根 ✓。
4. **底板留缝**：每块底板独立圆角、板间留缝（沿用原素材风格，平铺后自然成"每格一块板"）。
5. **禁止跨切片绘制**连续大图形；确需跨界的装饰（如未来设备类型专属底纹）放 equipment 层，不进九宫格件。

### 3.4 与 S1（asset-drawing-standard.md）的关系

- S1 的 `layer-*` 功能层规范**不变**，继续管辖 equipment/ports/arrows/logo 等层
- 设备 SVG 中的 `layer-base` 语义变化：九宫格设备的底座**不再画在自己 SVG 里**（设备 SVG 只剩 equipment 等专属层）；S1 增补一节"九宫格底座设备"说明（T1.11a 一并修订 S1）

---

## 4. 打包管线变更（scripts/pack-assets.ts）

### 4.1 九宫格切片提取（新增）

- asset-manifest 新增 `NINESLICE_FILES` 白名单（`nineslice_unit.svg`）
- 提取逻辑：解析 9 个 `slice-*` 组 → 每组按其所在格输出一帧（256×256，源 64px × 4 超采样）
- 输出 9 帧，合计 ~0.59M 像素（对比现状 2 台设备底座 ~1.2M，且不再随设备数/尺寸增长）

### 4.2 层帧白名单（瘦身）

现状对每个 `layer-*` 都输出全画布帧，但 `base/ports/arrows/indicators/equipment` 整层帧**运行时无人消费**（用的是主帧整图 + 逐端口小帧）。改为白名单：

- **保留**：`logo`、`logo-glow`、`port-*`、`arrow-*`（T2.8 已消费）+ 未来 `state-*`
- **砍掉**：base/ports/arrows/indicators/equipment 整层帧（`_arrow_mask` 保留——T1.7 预览染色在用）
- 预期瘦身：仅此一项 devices 图集 -6 帧 ≈ -3.5M

### 4.3 Equipment/Logo 层帧 trim（配套子任务）

- sharp 裁掉帧内容 alpha bounds 外的透明，spritesheet JSON 写 `trimmed/spriteSourceSize/sourceSize`（PixiJS 原生支持）
- **运行时偏移补偿**：现有 PortHighlightRenderer/RenderSystem 假设"层帧与主帧同画布、anchor 0.5 对齐"，trim 后该假设破坏 → pack 输出附 trimOffset 元数据，渲染端按偏移定位（集中封装一个 `layerFrameAnchor()` 工具，改动面可控）
- 效果：6×6 设备的 equipment 层从 2.36M 全画布 → 实际内容大小（预计 < 0.5M）

### 4.4 图集回落

以上完成后 devices 图集预期回到 **4096² 以内**（`MAX_ATLAS_SIZE` 回调 4096，兼容性最稳）。九宫格件 + trim 层帧 + 各设备 equipment 小帧 + 传送带/UI 件，总量估算 < 10M。

---

## 5. 数据模型与运行时渲染

### 5.1 BuildingDefinition 扩展（buildings.ts）

```ts
interface BuildingDefinition {
  // ... 现有字段不变 ...
  /**
   * 底座渲染方式（T1.11）。缺省 'whole' = 现状整图（向后兼容，已放置设备零迁移成本）。
   * 'nineslice' = 底座走九宫格拼装，texture 字段此时的语义 = equipment 专属层帧 key
   * （该帧应为透明底的纯 equipment 内容）。
   */
  baseStyle?: 'whole' | 'nineslice';
}
```

- `baseStyle: 'nineslice'` 的设备：底座 = NineSliceAssembler 用 `nineslice/*` 9 件拼装；`texture` 帧（equipment 层）叠加其上；logo/端口高亮等层逻辑不变
- `baseStyle` 缺省 = whole：走现管线，**存量设备（粉碎机等无素材的、Depot 3×1）零影响**

### 5.2 NineSliceAssembler（新渲染模块）

```
src/game/render/NineSliceAssembler.ts
```

- 纯工具：`build(w: number, h: number): Container` —— 按 §2.2 规则从图集取 9 种帧，生成 w×h 个 64px Sprite 的容器（Sprite 锚点 = 各自格中心偏移，容器原点 = 设备左上角）
- 容器 `rotation = direction 弧度`、`position = 设备中心`——与现有设备 Sprite 同数学（RenderSystem L195 同款）
- **拼装结果缓存**：`Map<`${w}x${h}`, Container>`——同尺寸设备共享一份容器子树？否——PixiJS 节点不能多父。改为 `Map<尺寸, Sprite[]>` 的帧序数组缓存 + 每设备 clone，或直接按设备实例化（100 台 6×6 = 3600 Sprite，同图集纹理 batch 合批，性能见 §8 验收；若不达标，v2 升级为 RenderTexture 一次性烘焙整机底座 + LRU 缓存，接口不变）

### 5.3 RenderSystem / PlacementSystem 接线

- **RenderSystem.createEntry 分支**：`baseStyle === 'nineslice'` → 底座容器（NineSliceAssembler）+ equipment Sprite + logo 子树（logo 挂载逻辑照旧）；纹理 diff 键用 `nineslice|${definitionId}` 防误重建
- **PlacementSystem 预览**：预览节点同样走拼装；染色方案从"整帧 arrow_mask"（nineslice 无整帧）改为"容器内逐 Sprite tint 蓝色"（PreviewTintFilter 的 mask 双纹理方案保留给 whole 设备）
- **SelectionSystem / PortHighlightRenderer / DeleteSystem**：不依赖设备纹理实现（选中框=几何框、端口高亮=独立容器、删除=实体销毁），**零改动**；PortHighlightRenderer 的容器 position/rotation 数学与拼装容器一致，自动对齐

---

## 6. 兼容与迁移路径

**试点：refining_unit（3×3）**——3×3 是九宫格最小完整形态，迁移后必须与现状**像素级一致**（截图 diff 验收），风险最低、说服力最强：

1. `refining_unit.svg` 删除 `layer-base`（底座改由 nineslice 承担），主帧输出 = 纯 equipment（透明底，trim 存储新建 `nineslice_unit.svg` 按本方案切 9 件
3. buildings.ts：refining_unit 加 `baseStyle: 'nineslice'`
4. 其余设备不动（whole 兼容路径）

**不迁移**：Depot（3×1，单行整图）、传送带/UI 件。粉碎机/配件机等尚无素材的设备，未来立项时**直接按九宫格规格出稿**（equipment 层 + baseStyle 字段），不再画底座。

---

## 7. 任务拆分（T1.11a~d，排期见 implementation-phase-1.md T1.11）

| 子任务 | 内容 | 交付物 |
|--------|------|--------|
| **T1.11a 素材规范与源文件** | 绘制 nineslice_unit.svg 9 切片；修订 S1 增补"九宫格设备"章节 | `nineslice_unit.svg` + S1 v1.1 |
| **T1.11b 打包管线** | 切片提取 + 层帧白名单 + equipment/logo trim + trimOffset 元数据；验证图集回落 4096² | pack-assets.ts / asset-manifest.ts 更新 |
| **T1.11c 拼装渲染器** | NineSliceAssembler + RenderSystem/PlacementSystem 分支接线 + `baseStyle` 字段 | 渲染链路跑通 |
| **T1.11d 试点迁移与回归** | refining_unit 迁移 + 像素级对比 + 6×3/5×5/6×6 demo 验证 + 全量回归（t1/t2 测试 + 性能基准） | 验收报告 |

依赖顺序：a → b → c → d（b 依赖 a 的源文件；c 依赖 b 的切片帧；d 收口）。

---

## 8. 验收标准

1. **像素级还原**：3×3 九宫格拼装渲染 vs 现状整图渲染，同视角同缩放截图逐像素对比（zoom 1/2/4 三档），差异像素 = 0（或仅抗锯齿亚像素级，肉眼不可辨）
2. **任意尺寸正确性**：demo 放置 6×3、5×5、6×6 测试设备——边框完整一圈、柱子出现在每条内部竖格线端部、底板每格一块、无平铺接缝；旋转 90/180/270° 后仍正确
3. **端口高亮联动**：nineslice 设备的端口面板/箭头高亮位置与实际端口对齐（PortHighlightRenderer 数学不变，验证即可）
4. **图集瘦身**：`npm run pack-assets` 后 devices 图集回到 4096²，帧数与面积对账（九宫格 9 帧 ~0.59M + trim 后层帧）
5. **性能**：`__game` 新增 demo 钩子铺 100 台 3×3 + 50 台 6×6 九宫格设备，FPS ≥ 55（对齐 T1.10 基准；不达标则启动 §5.2 的 RenderTexture 烘备升级）
6. **回归**：t21~t28 全部单测/浏览器验收无破坏；whole 路径设备（Depot 若有素材时）渲染不变

---

## 9. 风险与开放问题

| 风险 | 应对 |
|------|------|
| 平铺接缝（美术稿边缘不连续） | §3.3 硬约束 + 验收 #2 专项检查；打包期可加自动检测（相邻切片边缘 alpha 对比）留作后续 |
| 3600 Sprite 合批性能未知 | 验收 #5 门槛兜底；备选 RenderTexture 烘焙方案已预留（接口不变，纯内部升级） |
| trim 偏移破坏"同画布 anchor 0.5"假设 | trimOffset 元数据 + `layerFrameAnchor()` 统一封装，改造集中在 PortHighlightRenderer/RenderSystem 两处消费点 |
| 柱子归属规则（§3.3-3）与原素材位置有亚像素出入 | 迁移验收 #1 像素对比时单列此项，允许美术微调源文件对齐 |
| 未来 1×1 设备多起来想要九宫格退化 | v2 再议（三宫格/整图），v1 明确排除（§2.3） |

---

## 10. 明确不做（排除项）

- 单行/单列设备的九宫格退化（w=1 或 h=1 走整图）
- 九宫格件旋转归并（4 角共享 1 帧 + 运行时 rotation，可再省 ~0.4M）——收益小、增加拼装复杂度，v1 直接存 9 帧
- 传送带、UI、物品图集改造（不涉及）
- 已放置存量设备的自动迁移（whole 路径永久兼容，迁移按设备逐个自愿）
