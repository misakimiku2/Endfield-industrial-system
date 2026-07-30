# 素材绘制命名标准

> **版本**: 1.0  
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
- [ ] 存在 `layer-base`（至少空层）
- [ ] 所有可见元素都在某个 `layer-*` 组内
- [ ] 功能层 id 使用短横线分隔，英文小写
- [ ] 功能层之间不嵌套
- [ ] 没有 id 重复
- [ ] 运行 `npm run pack-assets` 无报错
