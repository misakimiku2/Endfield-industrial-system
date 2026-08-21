# 九宫格端口变体方案（Nine-Slice Port Variants）

> **编号**: S3（S2 nine-slice-device-base.md 的后续篇）
> **状态**: ✅ 已实施（T1.12，2026-08-21；验收记录见 §6/§9）
> **提出背景**: 2026-08-20 端口三组并入切片（S2 §11.4）后，切片端口采用"顶/底行每格一口"假设。
> 用户提出未来需要**无端口变体**（部分格/整行无端口的设备），要求预先出设计规范。
> **2026-08-20 第二轮补充（用户）**: 液体输入输出口（现精炼炉侧边的液口）未来也可能出现在
> **顶边/底边**——液体口与固体口功能相同（输入/输出），只是传输物品与造型不同。
> 方案据此升级为"**每格端口类型掩码**"（无/固体/液体），液体口进 kit。
> **2026-08-21 实施时追加（用户）**: `3x3_unit.svg` 新增 `Decoration` 组（D1/D2 侧边
> 装饰条）——**无液体口侧边**显示的装饰，同样分格拼接（→ §3.4 `deco-l/r`）。
> **2026-08-21 二轮修订（用户）**: ① 原在底座的 6 块端口底板移入新 `ports_base`
> 组——底板是端口的黑色背景，**跟端口走**（→ §3.1，无端口格镂空）；② 端口旁的
> `emblazon` 小方块（T1.11 曾当作"柱子"钉在底座切片）真实语义是**夹在相邻端口
> 之间的分隔块**——沿一行看是 `1 0 1 0 1`（1=端口，0=emblazon），无端口则不
> 显示（→ §3.5，从底座切片拆为跟掩码走的叠加件）。
> **原则**: 视觉端口 = 逻辑端口的派生（单一真相源是 `BuildingDefinition.ports`，
> 不新增设备定义字段）。

---

## 0. 一句话

把端口内容从切片组里**再拆一层**成为独立的切片组——固体口 `port-*`、液体口
`lport-*`——运行时按 `def.ports` 派生的**四边端口掩码**（顶/底行逐格 + 左/右列
逐行）逐位叠加：任意"哪些格有什么类型的口"的组合都是拼装参数，美术每种口型
只维护一份，新增设备零端口美术成本。无液体口的侧边由 `deco-l/r` 装饰条填充
（2026-08-21 追加）。

---

## 1. 背景与动机

### 1.1 现状（S2 §11.4 之后）

`nineslice_unit.svg` 的顶/底行 6 类切片（tl/t/tr/bl/b/br）各自**固定携带**
mid 面板 + top 面板 + 箭头。拼装规则只看 w×h，不知道逻辑端口在哪——即默认
"顶行每格一个输出口、底行每格一个输入口"（精炼炉模式）。液体口（精炼炉
`liquid_export`/`liquid_import`）画在设备 SVG 的 `layer-equipment`，逐设备自带。

### 1.2 要满足的场景

| 场景 | 例子 | 现状问题 |
|------|------|----------|
| 部分格端口 | 采种机 5×5：底行 dx=1..3 三个输入口，两角无口 | 角格被强塞端口，视觉与逻辑不符 |
| 整行/完全无端口 | 装饰平台、无对接的储罐类设备 | 顶/底行全是端口，视觉噪音 |
| **液体口上/下边** | 未来化工设备：顶边液体出口、底边液体入口（管道竖接） | 液体口只能走 equipment，逐设备画 |
| **液体口侧边多行** | 高设备（5×5）左侧两行各一个液口 | 现精炼炉液口固定在中间行，equipment 逐设备画 |

### 1.3 端口模型认知（用户确认的功能等价性）

液体输入输出口与固体（传送带）口的**功能完全相同**：都有输入/输出方向，只是
传输的物品（液体 vs 固体）与造型不同。因此：

- 视觉层：两种口都是"逐格重复件"，同等对待进 kit；
- 数据层（⚠️ 前置依赖，见 §7）：现 `PortType = 'input' | 'output' | 'liquid'`
  把"方向"与"介质"耦合（液体口无方向字段，靠位置约定左出右入）。液体口上/下边
  落地时，A3 端口模型应演进为 `方向(in/out) × 介质(solid/liquid)` 二维表达；
  S3 的掩码派生规则按新模型书写，旧模型按 §5.2 的过渡规则映射。

### 1.4 方案选型

| 路线 | 说明 | 结论 |
|------|------|------|
| ① 变体帧（slice-tl-np 等） | 每类切片做"有口/无口"两份 | ✗ 底座内容双份维护，组合爆炸（还要 ×固体/液体） |
| ② 设备 SVG 自画端口盖住 | 无端口切片 + 设备自己画 | ✗ 回到逐设备美术，违背"零美术成本" |
| ③ **拆层 + 类型掩码（本方案）** | 底座切片去端口化 + 独立 port-*/lport-* 切片组，运行时按四边掩码叠加 | ✓ 每个元件只维护一份；任意组合零美术成本 |

---

## 2. 方案总览

```
拼装结果 = 底座切片网格（slice-*，无端口）
          + 固体端口切片（port-*，仅顶/底掩码命中的格）
          + 液体端口切片（lport-*，四边掩码命中的格）
          + 侧边装饰条（deco-l/r，液体位图全 0 的侧边中间行逐行平铺）
          + 设备 equipment 层（剩余专属部件）
          + logo 层（现状不变）
```

**端口掩码**从设备定义派生，不新增字段。四边各一组位图，每种介质一位：

```ts
/** 一条边的端口位图（solid/liquid 各一张；顶/底边按列 dx 置位，左右边按行 dy 置位） */
interface EdgePorts { solid: number; liquid: number }

interface PortMask {
  top: EdgePorts;     // w 位
  bottom: EdgePorts;  // w 位
  left: EdgePorts;    // h 位（液体侧口；固体侧口见 §7 不做）
  right: EdgePorts;   // h 位
}
```

- 精炼炉（3×3）→ top.solid=0b111、bottom.solid=0b111、left.liquid=0b010
  （dy=1 行）、right.liquid=0b010 → **渲染与现状逐像素一致**（迁移零视觉变化）
- 采种机式（5×5，dx=1..3）→ top.solid=bottom.solid=0b01110 → 两角无口
- 化工塔式（4×4，顶行 2 个液体出口 + 底行 2 个液体入口）→ top.liquid=0b0101 等
- 无端口设备 → 全 0 → 纯底座

旋转：掩码定义在默认朝向（0°），容器整体旋转，视觉口随逻辑口一起转（与现有
port 旋转语义一致）。

**方向约定**（沿现有素材惯例，kit 切片按此定型）：顶边 = 输出口造型、底边 =
输入口造型；左右边 = 左出口、右进口（现精炼炉 liquid_export 左 / liquid_import 右）。
设备若需要违反约定（如顶边放输入口），该口走 equipment 层自画（§7）。

---

## 3. 美术规范（nineslice_unit.svg 改造）

### 3.1 固体口（剪切-粘贴，坐标零修改，约 30 分钟）

把现有 6 个顶/底行切片组里的 3 个端口元素（`*-port-mid`、`*-port-top`、
`*-port-arrow`）剪切出来，按同格放入新建的 `port-*` 组：

```
port-tl / port-t / port-tr     ← 顶行（输出口造型，箭头朝上）
port-bl / port-b / port-br     ← 底行（输入口造型，箭头朝上）
```

| 组 | mid 面板（#cbc9c9, 12.153×8.669） | top 面板（#e0dede, 10.455×5.859） | 箭头（#828080 描边 0.79375 圆帽） |
|----|----------------------------------|-----------------------------------|----------------------------------|
| port-tl | x=3.051821 y=3.041890 | x=3.900808 y=3.041892 | 顶点(9.128489, 4.749030) 两翼 y=6.257031 |
| port-t  | x=19.323446 y=3.042707 | x=20.172321 y=3.042709 | 顶点(25.400002, 4.749030) |
| port-tr | x=35.595318 y=3.042706 | x=36.444194 y=3.042708 | 顶点(41.671873, 4.749030) |
| port-bl | x=3.051821 y=39.088531 | x=3.900808 y=41.899155 | 顶点(9.128489, 44.542969) 两翼 y=46.050968 |
| port-b  | x=19.323446 y=39.087875 | x=20.172321 y=41.898422 | 顶点(25.400002, 44.542969) |
| port-br | x=35.595318 y=39.087891 | x=36.444194 y=41.898422 | 顶点(41.671873, 44.542969) |

**2026-08-21 二轮修订（用户）**: port-* 组升级为**四元素**——首位增加端口底板
`*-board`（#202020, 12.964583×10.794909，即用户从 layer-base 移入 `ports_base`
组的端口黑色背景）。底板跟端口走：掩码命中的格才有底板+面板，未命中的格顶/底行
**镂空**（只剩边框带，与中间行"画框"一致的观感）。slice-* 底座切片相应只剩边框环。

### 3.2 液体口（新绘 + 改制，一次性 kit 投资）

液体口切片 = 现有 `liquid_export.svg` / `liquid_import.svg` 造型按所在边适配，
共 8 组。**顶/底边是新造型（半圆盘贴合横边带，需旋转改制），左右边直接沿用
现有侧边造型归组**：

| 组 | 内容 | 造型基准 | 状态 |
|----|------|----------|------|
| lport-tl / lport-t / lport-tr | 顶边液体**出口** | liquid_export 旋转 90°（半圆盘挂顶边带，箭头朝上，黄色指示点 #ffef00） | 新绘 |
| lport-bl / lport-b / lport-br | 底边液体**入口** | liquid_import 旋转 90°（半圆盘挂底边带，白色指示点 #ffffff） | 新绘 |
| lport-l | 左边液体**出口** | liquid_export 现造型（贴合左竖轨） | 现素材归组 |
| lport-r | 右边液体**入口** | liquid_import 现造型（贴合右竖轨） | 现素材归组 |

绘制硬约束：
1. 每组内容画在自己对应的格内（顶行组在第 0 行、底行组在第 2 行、lport-l 在
   第 1 行第 0 列、lport-r 在第 1 行第 2 列），提取窗口与切片相同
   （±1.0583 单位边距，72px 源窗）——侧口造型允许像柱子一样小幅越出格界，
   越界内容随窗口保留（先测量确认 ≤ 1.0583，超出则调小造型）。
2. 半圆盘贴边安装：顶/底口贴合横边带外沿（y≈1.32~1.85 一带），左右口贴合竖轨
   （x≈1.32~1.85 / 48.95~49.48），与现素材对侧边的贴合方式一致。
3. 出口/入口的区分沿用现素材语言：出口 = 黄色指示点 + 箭头朝**外**（物流方向），
   入口 = 白色指示点 + 箭头朝**外**（指向对接来路），即各自保持 liquid_export /
   liquid_import 的既有约定，不做新发明。
4. 顶/底边的左 中 右三列是否需要像固体口那样区分外列/中列几何，由美术定夺
   （液体口是圆形件，左右对称，建议三列同款居中，仅按掩码落位——比固体口简单）。

### 3.4 侧边装饰条 deco-l / deco-r（2026-08-21 实施时追加，用户素材）

用户在 `3x3_unit.svg` 新绘 `Decoration` 组（D2 左 / D1 右，#cbc9c9 竖向饰条，
帽端 45° 斜切）——**无液体口侧边**显示的装饰，坐标零修改移入 `deco-l`/`deco-r`
组（各画在自己对应格 (1,0)/(1,2)）。

- **语义（每侧边整体回退）**: 某侧边液体位图全 0 → 该侧中间行（1..h-2）逐行平铺
  deco；有任一液体口的侧边整侧不显示 deco（避免装饰条与液口在同一侧边混排打架）。
  掩码已有液体位 → 运行时零新字段直接派生。
- **平铺连续性**: 帽端斜切越出格界 **1.8765 单位** > 标准窗口边距 1.0583——
  deco 组提取窗口边距放大到 **2.1167 单位（8px）**保帽端完整；相邻行平铺时
  不透明同色重叠（重叠带 4.24 单位）合并为**连续饰条**，仅首/末行帽端可见。
- 帧尺寸因此为 80px 源窗（4× 超采样后 320²），运行时 deco Sprite 覆盖
  80×80 世界像素（`NINESLICE_DECO_SPAN`，与切片的 72 区分）。

### 3.5 emblazon 端口间小方块（2026-08-21 三轮修订定型，用户澄清语义）

原 3x3_unit.svg 里 4 颗 `emblazon_*` 小方块（#828080, 1.3229×3.9688）在 T1.11
曾被当作"柱子"钉进底座切片（假设"每条内部竖格线恒一颗"）。用户三轮澄清定型：
emblazon 是**端口的伴随分隔块，跟端口走**——内部边界 c|c+1 任一侧有固体口就显示
一颗（端口两侧各一颗；角格口只内侧一颗；两侧都无口不显示）。满口行退化为每边界
一颗 = 原素材 `1 0 1 0 1` 排列；单口非角格（如 4×3 的中口）两侧各一颗。

- 组: `emblazon-ta / emblazon-tb`（顶行 A/B 形，格 (0,1)/(0,2) 左缘）、
  `emblazon-ba / emblazon-bb`（底行，格 (2,1)/(2,2) 左缘）——几何 = 原 4 颗
  emblazon 零坐标迁移。A/B 两形互为镜像（A 跨界线左 0.3307/右 0.9922，B 反之）。
- 运行时规则（buildNineSlicePorts）: 逐行（顶/底独立）扫内部边界 c|c+1，
  `(solid[c] | solid[c+1]) ≠ 0` → 该边界放一颗，贴边界**右侧格**；A/B 按**边界
  序号奇偶**交替（偶 A 奇 B）——形式只取决于边界位置、与端口分布无关，且 3×3
  满口时与原素材的 A、B 排列逐像素一致。精炼炉（全口）→ A、B 各一颗。
- 与端口底板同轮次的连带修订: slice-t/tr/b/br 底座切片的"柱子"移除。

### 3.3 未来新端口皮肤（预留，不在本任务）

若某类设备要不同风格的端口件（农业口/电力口），另建 `nineslice_port_xxx.svg`
按同规范切组，键名前缀区分。管线零改动（§4 按 `port-`/`lport-` 前缀识别），
运行时按设备类别选皮肤——待第一个真实需求出现再定。

---

## 4. 打包管线（pack-assets.ts）

`extractNinesliceSlices` 扩展：除 9 个 `slice-*` 组外，识别 `port-*`（6 组）、
`emblazon-*`（4 组，二轮）、`lport-*`（8 组）与 `deco-l`/`deco-r`（2 组），
同样按"所在格 ± 边距"窗口提取（deco 组边距 8px，其余 4px）。输出键：

| 组 | 纹理 key |
|----|----------|
| port-tl…port-br | nineslice/port-tl … nineslice/port-br（6 帧，含端口底板） |
| emblazon-ta/tb/ba/bb | nineslice/emblazon-*（4 帧，端口间小方块） |
| lport-tl…lport-br | nineslice/lport-tl … nineslice/lport-br（6 帧） |
| lport-l / lport-r | nineslice/lport-l、nineslice/lport-r（2 帧） |
| deco-l / deco-r | nineslice/deco-l、nineslice/deco-r（2 帧，320²） |

- 帧尺寸与切片一致（288²，4× 超采样；deco 320²；全透明组跳过的规则同 c 块）
- 图集增量：+20 帧 ≈ +1.7M 像素（实测 4096×2048 = 8.4M 仍有余量；若紧张，
  端口帧可开 trim——内容仅约 50×40 源px，PixiJS 原生 trim 对消费方透明，
  留作优化项）

---

## 5. 运行时（NineSliceAssembler / RenderSystem / PlacementSystem）

### 5.1 组装 API

```ts
/** 四边端口位图（§2 的 PortMask），从 BuildingDefinition.ports 派生 */
export function portMaskFromDef(def: BuildingDefinition): PortMask
// （实现在 src/game/render/PortMask.ts——叶子模块，离线脚本可直接单测）

/** 底座网格（现状 buildNineSliceBase，去端口化） */
buildNineSliceBase(w, h, getTexture): Container

/** 端口叠加层：四边掩码命中的格各放一个 port-*/lport-* Sprite +
    液体位图全 0 的侧边中间行逐行放 deco-l/r（z 序在底座之上） */
buildNineSlicePorts(w, h, mask, getTexture): Container

/** 烘焙：底座+全部端口+deco → 单张 RenderTexture；缓存键含四边 solid/liquid 位图 */
getBakedNineSliceTexture(w, h, mask, renderer, getTexture): Texture
```

- 烘焙缓存含掩码：同尺寸同掩码的设备共享一张；缓存规模 ≈ 设备款数（每款 ports 唯一）
- 预览 / 工具栏图标同构（叠一层 ports，tint 逐 Sprite 自动覆盖）
- PortHighlightRenderer **零改动**（逐端口高亮帧仍来自设备 SVG 隐藏层；kit 白帧
  泛化见 §7）

### 5.2 掩码派生规则（含旧数据模型过渡）

**目标模型**（A3 演进后，端口 = 方向 × 介质）：

| 端口定义 | 掩码动作 |
|----------|----------|
| medium=solid, direction=out, dy=0 | top.solid \|= 1<<dx |
| medium=solid, direction=in, dy=h-1 | bottom.solid \|= 1<<dx |
| medium=liquid, direction=out, dx=0 | left.liquid \|= 1<<dy |
| medium=liquid, direction=in, dx=w-1 | right.liquid \|= 1<<dy |
| medium=liquid, direction=out/in, dy=0 / dy=h-1 | top.liquid \|= 1<<dx / bottom.liquid \|= 1<<dx |

**过渡规则**（现 `PortType = 'input'|'output'|'liquid'`，液体口无方向）：

| 现定义 | 映射 |
|--------|------|
| type=input/output, dy=h-1/0 | bottom.solid / top.solid（同目标模型） |
| type=liquid, dx=0（任意 dy） | left.liquid \|= 1<<dy（左=出口，现约定） |
| type=liquid, dx=w-1（任意 dy） | right.liquid \|= 1<<dy（右=进口） |
| type=liquid, dy=0 或 dy=h-1 | **不进掩码**（顶/底液体口需方向信息，等 §7 数据模型拆分后启用；此前此类口走 equipment 自画） |

精炼炉用过渡规则派生：left.liquid=0b010、right.liquid=0b010 → 与现状逐像素一致。

---

## 6. 兼容与验收（2026-08-21 实施后全部通过；同日二轮修订后复验仍全绿）

1. **精炼炉零变化**: ✅ 离线逐像素 0 差异（verify-t1.12 B：新链路
   [slice+port+emblazon+lport] vs [原素材含 ports_base/emblazon]）+ 浏览器运行时
   探针（面板/emblazon/液口颜色与位置全部命中，verify-t1.12-runtime）。
   **精炼炉液口 equipment→lport 迁移已完成**（refining_unit.svg 的 layer-equipment
   清空，lport-l/r 即其原路径零坐标迁移）——迁移等价性由上述 0 差异覆盖。
2. **无端口设备**: ✅ demo `test_nineslice_noport`（ports 空）渲染纯底座（顶/底行
   镂空——底板跟端口走）+ 两侧 deco 装饰条；与用户 base+Decoration 素材
   （隐藏 ports_base/ports/emblazon）逐像素 0 差异（verify-t1.12 C）
3. **部分固体端口**: ✅ `test_nineslice_4x3` 掩码 0b0100/0b0010 → 只有命中格有
   底板+面板，缺口格镂空；单口无相邻 → 无 emblazon；旋转 90° 后 deco/底座随
   容器转（运行时探针 + 截图）
4. **液体口**: ✅ 侧边液体多行 demo `test_nineslice_liquid_5x5`（左 dy=1,3 两盘 +
   右 dy=2 一盘，有液口侧不显 deco）贴边/方向正确；顶/底液体口**造型与管线已就绪**
   （lport-t*/b* 帧已打包、拼装与探针验证通过——verify-t1.12 E），def 置位待
   A3 端口模型拆分（§7.1）后启用
5. **图集**: ✅ +20 帧后 4096×2048（≤ 4096²）
6. **回归**: ✅ verify-t1.11（12/12，对比基准 = slice+port+emblazon 全叠加 vs
   原素材）、t28 高亮对齐（17/17）、运行时探针 25/25

---

## 7. 依赖与明确不做

### 7.1 ⚠️ 前置依赖：A3 端口数据模型拆分（仅液体上/下边需要）

液体口要出现在顶/底边，`PortType` 需从 `'input'|'output'|'liquid'` 演进为
**方向 × 介质** 二维（如 `{ direction: 'in'|'out', medium: 'solid'|'liquid' }`
或 `type: 'input'|'output'` + `medium: 'solid'|'liquid'`），否则顶边液体口无法
表达"它是出口还是入口"。这是 A3（building-spec）层面的数据模型修订，波及
buildings.ts / MachineSystem / PortStatusOps 等 Phase 2 消费方——**独立小任务**，
在第一台顶/底液体口设备立项时先做。S3 的掩码派生按目标模型书写（§5.2），
过渡规则保证旧模型设备（精炼炉）即时可用。

### 7.2 明确不做（排除项）

- **固体口出现在左右边**: 现有固体物流约定为传送带竖接（顶出/底入），左右边
  固体口无需求；真出现时按 lport 同款扩 `port-l/port-r` 切片 + left.solid/right.solid
  位（结构已预留，勿需改架构）
- **违反"顶出/底入/左出/右入"方向约定的口**: 走设备 equipment 层自画
  （kit 切片按方向定型，避免每方向 × 每介质 × 每位置的组合爆炸）
- **PortHighlightRenderer 的 kit 白帧泛化**: 让新设备免画逐端口高亮隐藏层的
  自然后续（kit 出白源端口帧 + 渲染器按端口格放小 Sprite，固体+液体通用），
  牵扯 T2.8 状态视觉回归面较大，与端口变体解耦，待第一台"无自有 SVG 端口层"
  的设备立项时再做
- **端口皮肤变体**: §3.3 预留命名，不实现

---

## 8. 实施拆分（T1.12，✅ 2026-08-21 全部完成）

| 步骤 | 内容 | 交付物 | 状态 |
|------|------|--------|------|
| a | 美术-固体: slice 组端口三元素剪切到 port-*（§3.1，坐标零修改） | port-* 6 组 | ✅ |
| b | 美术-液体: lport 左右组归组 + 顶/底组新绘（§3.2）+ deco-l/r（§3.4 追加） | lport-* 8 组 + deco 2 组 | ✅ |
| c | 管线: extractNinesliceSlices 识别 port-*/lport-*/deco-* | nineslice/* +16 帧 | ✅ |
| d | 运行时: portMaskFromDef（含过渡规则）+ buildNineSlicePorts + 烘焙缓存键 | 渲染链路 | ✅ |
| e | 验收: §6 六项 + 文档同步（S1 §9.2 ⚠️ 条目解除） | 验收报告（§6/§9） | ✅ |

**落地文件**: 素材 `nineslice_unit.svg`（组重排 + lport-t*/b* 旋转变换新增）、
`refining_unit.svg`（液口迁出 equipment）；管线 `pack-assets.ts` +
`asset-manifest.ts`（组表 + deco 8px 边距）；运行时 `PortMask.ts`（新，叶子模块）、
`NineSliceAssembler.ts`（buildNineSlicePorts + 掩码烘焙键）、`RenderSystem.ts` /
`PlacementSystem.ts` / `InventoryUI.ts`（接线）；demo 设备 `buildings.ts`
（test_nineslice_noport / test_nineslice_liquid_5x5）；验收脚本
`verify-t1.12-portvariant.mjs`（离线 20/20）、`verify-t1.12-runtime.mjs`
（浏览器探针 21/21）、`verify-t1.12-visual.mjs`（截图）。

**遗留（按计划后置，非本任务缺口）**: 顶/底液体口的 def 置位依赖 A3 端口模型
"方向×介质"拆分（§7.1，独立小任务）；届时掩码派生规则按 §5.2 目标模型补
top.liquid/bottom.liquid 两个分支即可，管线/拼装/烘焙零改动。
精炼炉 arrow_mask 帧随液口迁出不再生成（nineslice 设备预览染色走逐 Sprite
tint，无消费方，verify-t1.11 基准帧已换 3x3_unit）。

**2026-08-21 二轮修订记录（用户反馈）**: ① ports_base（端口底板）并入 port-* 四
元素，无口格镂空；② emblazon 从底座切片拆为 emblazon-ta/tb/ba/bb 4 帧，按
"相邻固体口边界 + A/B 交替"叠加（§3.1/§3.5）。改动面: nineslice_unit.svg、
pack-assets.ts（+4 帧 → nineslice/* 共 28 帧）、NineSliceAssembler（emblazon
循环）、verify-t1.11/-t1.12 系列基线更新。复验: verify-t1.11 12/12、
verify-t1.12-portvariant 21/21、verify-t1.12-runtime 25/25、t28 17/17——
精炼炉对二轮前仍逐像素 0 差异。

**2026-08-21 三轮修订记录（用户反馈）**: emblazon 规则从"相邻两口之间（AND）"
修正为"任一侧有口即显示（OR）"——端口两侧各一颗、角格口只内侧一颗、两侧无口
不显示；A/B 交替从"可见颗序"改为"边界序号奇偶"（位置稳定）。新增满口 demo
设备 `test_nineslice_full_5x5`（顶/底整行固体口 + 两侧 deco 同屏验证）。
复验: verify-t1.11 12/12、verify-t1.12-portvariant 21/21、
verify-t1.12-runtime 30/30、t28 17/17。
