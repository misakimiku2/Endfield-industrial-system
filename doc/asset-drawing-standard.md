# 素材绘制命名标准

> **版本**: 1.1（T1.11a 增补"九宫格设备底座"章节 §9）  
> **适用范围**: 所有以 SVG 为源文件的游戏美术资源（设备、UI 等）。物品 PNG 图标暂不受影响。  
> **目标**: 让构建脚本 `scripts/pack-assets.ts` 能自动把 SVG 拆分为可组合的功能层，供运行时按状态叠加渲染。

---

## 1. 画布尺寸标准

SVG 画布必须**严格等于该设备的占地面积（footprint）像素尺寸**。

```
width  = footprint.w × CELL_SIZE px
height = footprint.h × CELL_SIZE px
```

其中 `CELL_SIZE = 64 px`。

| footprint | 画布尺寸 | 典型设备 |
|-----------|----------|----------|
| 1×1       | 64 × 64  | 小型单元 |
| 3×3       | 192 × 192 | `3x3_unit`（通用 3×3 底座）、`refining_unit`（精炼炉） |
| 5×5       | 320 × 320 | 大型设备 |

> **注意**: 不需要在 SVG 里画 4× 大小。构建脚本 `DEVICE_RASTER_SCALE=4` 会自动放大光栅化，保证 zoom=4 时纹素:像素 ≈ 1:1。

---

## 2. 功能层命名约定

所有需要被程序单独控制的可视元素，必须放在 `<g id="layer-<name>">` 分组内。

### 2.1 强制/推荐层

| 层 id | 用途 | 是否必须 | 说明 |
|-------|------|----------|------|
| `layer-base` | 底盘、边框、占位框等所有同 footprint 设备可复用的主体 | **必须** | 若设备完全无静态主体，可为空，但不建议删除该层 |
| `layer-equipment` | 设备专属主体部件（如精炼炉 logo、炉体、烟囱、特殊管道） | 按需 | 同一 footprint 的通用底座上叠加不同设备主体时使用；应放在独立 SVG 中，不要混入通用底座 |
| `layer-ports` | 端口接口、连接器面板 | 可选 | 未来接入传送带时可能变色 |
| `layer-arrows` | 端口方向箭头 | 可选 | T1.7 预览染色会提取该层生成 mask |
| `layer-indicators` | 状态指示灯、工作动画等会变化的元素 | 按需 | Phase 2 动态表现主要使用该层 |
| `layer-logo` | 设备徽标、标识等需要**始终屏幕朝上**的 billboard 元素 | 按需 | 默认 `display:none`，完整帧会自动排除；运行时会单独叠加并反向旋转 |
| `layer-state-<xxx>` | 特殊状态层 | 按需 | 例如 `layer-state-error`、`layer-state-connected` |

### 2.2 命名规则

1. **前缀固定**: 所有功能层必须以 `layer-` 开头。
2. **分隔符**: 使用短横线 `-`，不要使用下划线 `_`。
   - ✅ `layer-base`
   - ❌ `layer_base`
   - ❌ `layerBase`
3. **英文小写**: 层名使用英文小写。
4. **不允许嵌套**: 功能层之间不能互相嵌套（一个 `layer-*` 不能包含另一个 `layer-*`）。
5. **兄弟关系**: 所有 `layer-*` 应作为同一父级（通常是 Inkscape 的图层 `layer4`）下的兄弟节点。

### 2.3 层外元素

不要保留游离在 `layer-*` 之外的可见图形元素（如 `border`、`emblazon` 等）。这些元素应归入 `layer-base` 或合适的层中。

> 例外: Inkscape 自身的辅助元素（如 `sodipodi:namedview`、不可见的 guide）可以保留在层外。

---

## 3. 层内元素命名

**层内元素（子组、rect、path、circle 等）的 id 可以任意**。

构建脚本只识别 `layer-*` 分组，不依赖内部元素 id。但为了人工维护方便，建议使用语义化命名：

```xml
<g id="layer-arrows">
  <path id="Arrow_2_1" ... />
  <path id="Arrow_2_0" ... />
  <path id="Arrow_0_2" ... />
</g>
```

| 类型 | 建议命名 | 是否强制 |
|------|----------|----------|
| 端口箭头 | `Arrow_<row>_<col>` | 否 |
| 端口面板 | `port_mid_<row>_<col>` / `port_top_<row>_<col>` | 否 |
| 底盘单元 | `base_<row>_<col>` | 否 |
| 状态指示灯 | `indicator_<row>_<col>` | 否 |

---

## 4. 内部子组

如果设备由多个相同模块组成（例如 3×3 设备有 6 个端口位置），可以在 `layer-*` 内部使用子组来组织，但子组 id 不要以 `layer-` 开头。

### 推荐方式

按位置建子组，id 使用 `pos-<row>-<col>` 或 `<prefix>-pos-<row>-<col>`：

```xml
<g id="layer-base">
  <g id="base-pos-2-1" transform="translate(10,20)">
    <rect id="base_2_1" ... />
  </g>
  <g id="base-pos-2-0" transform="translate(30,20)">
    <rect id="base_2_0" ... />
  </g>
</g>
```

> 注意: 同一位置在不同层中的子组 id 应不同，避免 SVG id 重复。例如 `base-pos-2-1`、`ports-pos-2-1`、`arrows-pos-2-1`。

### 替代方式

也可以直接把元素扁平地放在 `layer-*` 内，不建位置子组。只要每个元素的 transform 正确即可。

---

## 5. 构建输出

符合本标准的设备 SVG，在运行 `npm run pack-assets` 后会生成以下图集帧：

| 图集 key | 内容 |
|----------|------|
| `<device_key>` | 完整设备（所有层可见，兼容现有单 Sprite 渲染） |
| `<device_key>/base` | 仅 `layer-base` |
| `<device_key>/ports` | 仅 `layer-ports` |
| `<device_key>/arrows` | 仅 `layer-arrows` |
| `<device_key>/indicators` | 仅 `layer-indicators` |
| `<device_key>/equipment` | 仅 `layer-equipment`（设备专属部件） |
| `<device_key>/logo` | 仅 `layer-logo`（billboard 徽标，保持屏幕朝上） |
| `<device_key>_arrow_mask` | T1.7 预览染色 mask（兼容用，后续可能迁移到 `/arrows`） |

所有层的 `sourceSize` 与完整设备帧一致，运行时可直接按同一尺寸叠加。

---

## 6. 示例：3×3 设备

```xml
<svg width="192" height="192" viewBox="0 0 192 192" ...>
  <g id="layer4" inkscape:label="3x3_unit" inkscape:groupmode="layer">
    <g id="layer-base" inkscape:label="base">
      <path id="border" ... />
      <rect id="placeholder" ... />
      <path id="emblazon_1" ... />
      <path id="emblazon_2" ... />
      <g id="base-pos-2-1" transform="translate(10,20)">
        <rect id="base_2_1" ... />
      </g>
      <!-- 更多 base-pos-* -->
    </g>

    <g id="layer-ports" inkscape:label="ports">
      <g id="ports-pos-2-1" transform="translate(10,20)">
        <rect id="port_mid_2_1" ... />
        <rect id="port_top_2_1" ... />
      </g>
      <!-- 更多 ports-pos-* -->
    </g>

    <g id="layer-arrows" inkscape:label="arrows">
      <g id="arrows-pos-2-1" transform="translate(10,20)">
        <path id="Arrow_2_1" ... />
      </g>
      <!-- 更多 arrows-pos-* -->
    </g>

    <g id="layer-indicators" inkscape:label="indicators">
      <!-- Phase 2 状态指示灯 -->
    </g>
  </g>
</svg>
```

---

## 7. 与现有设备的关系

- `3x3_unit.svg` 已按本标准重构为**通用 3×3 底座**（仅含 `layer-base`、`layer-ports`、`layer-arrows`、`layer-indicators`），作为同 footprint 设备的模板参考。
- `refining_unit.svg` 在 `3x3_unit` 底座基础上增加了 `layer-equipment`，构成**精炼炉完整外观**；其他 3×3 设备应类似地新建自己的 SVG，而不是去改 `3x3_unit.svg`。
- 后续新增设备应直接按本标准绘制；若与现有设备共用底座，可复制底座几何后叠加专属 `layer-equipment`。
- 旧设备 SVG 若未分层，仍可正常打包出完整设备帧，但无法输出 `/base`、`/ports` 等子帧，Phase 2 的动态表现需补充分层后才能支持。

---

## 8. 检查清单

提交新 SVG 前确认：

- [ ] 画布尺寸 = `footprint × 64 px`
- [ ] 存在 `layer-base`（至少空层）——**九宫格设备（§9）除外，其 SVG 不含 layer-base**
- [ ] 所有可见元素都在某个 `layer-*` 组内
- [ ] 功能层 id 使用短横线分隔，英文小写
- [ ] 功能层之间不嵌套
- [ ] 没有 id 重复
- [ ] 运行 `npm run pack-assets` 无报错

---

## 9. 九宫格设备底座（T1.11，方案 S2）

> 依据: [nine-slice-device-base.md](nine-slice-device-base.md)（S2 方案全文）。
> 本节是 S2 落地后的**实施规范**，含与 S2 原文的实测修正（见 §9.6）。

### 9.1 两类设备底座

`BuildingDefinition.baseStyle` 决定底座渲染方式：

| baseStyle | 底座来源 | 设备 SVG 内容 | 适用 |
|-----------|----------|---------------|------|
| `'whole'`（缺省） | 设备自己的 `layer-base` 整图 | 完整外观（base + equipment + …） | 1×n / n×1 设备（Depot）、旧设备 |
| `'nineslice'` | `nineslice_unit.svg` 9 切片运行时拼装 | **不含 layer-base**，只有 equipment/ports/arrows/logo 等专属层 | w≥2 且 h≥2 的新设备 |

九宫格设备的 `texture` 字段语义 = **equipment 专属层帧 key**（透明底的纯设备内容），
底座由拼装器提供，两者在渲染时叠加。

### 9.2 nineslice_unit.svg 结构

- 画布与 `3x3_unit.svg` 同规格（192px / viewBox 50.8，3×3 格，每格 16.9333 单位）。
- 9 个切片组，**内容画在自己对应的格内**（允许小幅越界，见 §9.4）：

```
slice-tl  slice-t   slice-tr
slice-l   slice-c   slice-r
slice-bl  slice-b   slice-br
```

- 打包输出 9 帧：`nineslice/tl` … `nineslice/br`（每帧含 1.0583 单位窗口边距，见 §9.5）。
- 切片内容 = 原通用底座素材的**四个组**（2026-08-20 用户追加端口三组并入）：
  1. `layer-base` 边框环 + 底板 + 柱子（全部切片；中间行空心画框，c 全空）
  2. `ports` mid 面板 `#cbc9c9` 12.153×8.669 —— 顶/底行 6 类切片，每格一个
  3. `ports_top` 顶面板 `#e0dede` 10.455×5.859（贴外缘窄条）—— 同上
  4. `arrows` 箭头 `#828080` 描边（0.79375 圆帽）—— 同上，方向=物流方向
     （默认朝向：顶行输出朝上、底行输入朝上，随容器整体旋转）
  即：**九宫格设备不再在自己的 SVG 里画 ports/arrows**——设备 SVG 只剩 equipment
  （如精炼炉液口）与 logo 等专属层；端口外观由切片自动铺满顶/底行。
  ⚠️ 该模式假设 logical ports "每格一口"（精炼炉模式）。若未来设备定义的端口
  只占部分格（如采种机 5×5 只 3 口），需设备 SVG 自画端口盖住切片端口，或届时
  为切片增加"无端口变体"（留待需求出现时决策）。

### 9.3 平铺规则（w×h 设备）

```
行 0:     tl, t×(w-2), tr
行 1..h-2: l,  c×(w-2), r
行 h-1:   bl, b×(w-2), br
```

### 9.4 绘制硬约束

1. **边框带切分重叠**：边框环按格切分归属各切片时，切缝两侧每边多画 0.3 单位
   （不透明同色重叠），避免抗锯齿切割缝出现半透明接缝。
2. **柱子归属**：t/b 切片左端画 A 形柱（线左 0.3307 / 线右 0.9922 单位），
   tr/br 切片左端画 B 形柱（镜像）——任意 w≥2 时每条内部竖格线端部恰好一根柱，
   且 3×3 拼装与原素材 4 根柱逐坐标一致。tl/bl/l/c/r 无柱。
3. **底板只在顶行与底行**（见 §9.6 实测修正）：中间行是空心"画框"，
   设备中间内容由各设备 equipment 层承担。
4. **平铺连续性**：t/b 的边框带、l/r 的竖向边框带平铺 N 份不得出现接缝/错位。

### 9.5 提取窗口

每个切片按其所在格 ±**1.0583 单位**（4px）边距的窗口光栅化（4× 超采样后 288²），
切片越界内容（柱子突出、边框重叠带）随窗口保留。运行时每个切片 Sprite 覆盖
72×72 世界像素、中心对齐所在格中心，相邻切片重叠 8px（内容不透明同色，无视觉影响）。

### 9.6 与 S2 原文的实测修正（2026-08-18 实施时发现）

S2 §1.3 称 base 层有"9 块底板"，**实测 `3x3_unit.svg` 只有 6 块**（顶行+底行各 3 块，
中间行仅有左右 2px 竖向边框带，无底板——设备中间是空心"画框"）。因此：

- c/l/r 切片**不含底板**（c 完全为空，不打包帧；l/r 只有竖向边框带）；
- S2 §8-2 验收中"底板每格一块"按实际素材调整为"底板每格一块（仅顶/底行）"。

此修正保证了 S2 验收 #1（3×3 拼装像素级还原）成立——已实测 0 差异像素
（`scripts/verify-t1.11-nineslice.mjs`）。

### 9.7 新增九宫格设备的流程

1. `buildings.ts` 加定义：`baseStyle: 'nineslice'`，footprint 任意 w,h ≥ 2；
2. 新建设备 SVG：**不画 layer-base**，只画 equipment/ports/arrows/logo 等层
   （画布仍 = footprint × 64 px，透明底）；
3. 设备 SVG **不画 layer-base / ports / arrows**（底座与端口外观由切片自动拼装），
   只画 equipment/logo 等专属层；
4. 重跑 `npm run pack-assets`——底座+端口零美术成本，由 nineslice 9 件拼装。

