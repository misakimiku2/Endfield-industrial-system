---
name: endfield-device
description: 明日方舟终末地集成工业系统——新增设备/建筑的标准流程（T1.11 九宫格底座 + T1.12 端口变体体系之后）。在"加设备/新建筑/画设备 SVG/加端口/改外观"等任务时使用。核心：底座、固体口、端口底板、emblazon、液体口、侧边装饰条全部由 BuildingDefinition.ports 自动派生，设备 SVG 只画真正专属的内容。1×n/特殊外观/非生产设备走 whole 整图路径（§3 Depot 先例）。
---

# 新增设备流程（T1.12 端口变体体系之后）

> 体系: S2 九宫格底座（nine-slice-device-base.md）+ S3 端口变体
> （nineslice-port-variant.md，2026-08-21 三轮修订定型）。
> 素材规范: asset-drawing-standard.md §9。

## 0. 核心认知：外观是数据的函数

`baseStyle: 'nineslice'` 的设备，其底座边框、固体口（含黑色底板 + 面板 + 箭头）、
emblazon 小方块、液体口、无液口侧边的装饰条（deco）**全部由 `def.ports` 派生的
四边端口掩码自动拼装**（`portMaskFromDef` → `buildNineSlicePorts`）。
任意"哪些格有什么类型的口"的组合都只是 buildings.ts 里的数据——零端口美术。

**设备 SVG 里禁画**: `layer-base`、ports/ports_top/arrows、ports_base（端口底板）、
emblazon、液体口、侧边装饰条。画了会和自动拼装的内容叠加错位。

## 1. 最快路径——纯 kit 设备（无专属外观）

只改 `src/game/data/buildings.ts`，一条定义即完成，无需任何 SVG/打包：

```ts
my_device: {
  id: 'my_device',
  name: '我的设备',
  category: 'production',            // extraction/production/logistics/defense/agriculture
  footprint: { w: 3, h: 3 },         // 任意 w,h ≥ 2（1×n/n×1 走 whole 整图路径，见 §3）
  ports: [
    // 端口位置即外观：下面 6 条 = 顶行整排输出口 + 底行整排输入口
    { type: 'output', position: { dx: 0, dy: 0 } },
    { type: 'output', position: { dx: 1, dy: 0 } },
    { type: 'input',  position: { dx: 1, dy: 2 } },   // 部分口：只写需要的格
    { type: 'liquid', position: { dx: 0, dy: 1 } },   // 左侧液体出口（黄点）
    { type: 'liquid', position: { dx: 2, dy: 1 } },   // 右侧液体进口（白点）
  ],
  texture: 'my_device',              // equipment 帧可以缺失 → 纯 kit 外观（渲染自动跳过）
  baseStyle: 'nineslice',
  selectable: true,
  buildCost: [...], powerConsumption: N, inputSlotCount: N, outputSlotCount: N, bufferCapacity: N,
},
```

端口语义速查（默认朝向 0°，旋转时视觉口随逻辑口整体转）:

| 写法 | 视觉效果 |
|------|----------|
| `output, dy=0` | 顶行 dx 格输出口（面板+箭头朝上+底板） |
| `input, dy=h-1` | 底行 dx 格输入口（箭头朝上） |
| `liquid, dx=0` | 左边 dy 行液体出口（半圆盘+黄点） |
| `liquid, dx=w-1` | 右边 dy 行液体进口（白点） |
| 不写 | 该格无口（镂空）；某侧边一条液体口都不写 → 该侧自动显示 deco 装饰条 |
| 自动 | 口两侧的内部边界自动出 emblazon 小方块（任一侧有口即显示，A/B 按边界奇偶交替） |

**顶/底边的液体口暂不支持**（现 `PortType` 无方向字段，等 A3 端口模型
"方向×介质"拆分后启用——kit 素材与管线已就绪，见 S3 §7.1）。

验收: 浏览器控制台 `__game.placeAt('my_device', 5, 5)`（可加第 4 参方向 0/90/180/270），
检查底座边框完整、口位置与 ports 一致、无口格镂空、deco/emblazon 正确、旋转正确。

## 2. 有专属外观——加设备 SVG（equipment/logo）

在情形 1 基础上：

1. **画布**: footprint × 64 px（3×3=192²，5×5=320²），透明底，坐标原点=设备左上角。
2. **只画专属层**:
   - `layer-equipment`——设备中间的专属内容（炉体、储罐、机械臂…）；
   - `layer-logo` / `layer-logo-glow`——billboard 徽标（可选，def 加 `logoTextureKey`）；
   - T2.8 端口高亮隐藏层（可选，但连接/堵塞黄红高亮依赖它，见 §5 已知边界）:
     `layer-port-in-{dx}` / `layer-port-out-{dx}`（白色面板 rect）、
     `layer-arrow-in-{dx}` / `layer-arrow-out-{dx}`（白色箭头 path），
     几何照抄 refining_unit.svg 的同名层（坐标 = 端口在设备画布的位置）。
3. **白名单**: `scripts/assets/asset-manifest.ts` 的 `DEVICE_FILES` 加文件名
   （texture key 不合意再动 `keyOverrides`）。
4. **打包**: `npm run pack-assets`。
5. 验收同情形 1。

## 3. 整图设备（whole 路径）——1×n / 特殊外观 / 非生产设备（Depot 先例，T2.12）

**何时走这条路**: 1×n/n×1 占地（九宫格不适用）、外观不适合 kit 拼装、非生产设备
（无限源/汇等特殊逻辑）。先例: `depot_unloader`/`depot_loader`（仓库取/存货口）。

### SVG 结构（硬规矩）

1. **画布**: footprint × 64 px（3×1=192×64），透明底，坐标原点=设备左上角。
2. **主内容必须住在 `<g id="layer-base">` 里**——不能沿用 Inkscape 默认的
   `layer1` 这类无连字符 id。原因: 层帧提取靠 CSS `g[id^="layer-"]` 隐藏其余层，
   不合规 id 的内容会**漏进每一个层帧**（T2.12 实际踩过）。
3. **tint 源层**（可选，悬停/状态高亮用）: `<g id="layer-status" style="display:none">`，
   内容**纯白填充**（白色源 × tint 才得到纯色高亮）。`display:none` 使它不进主帧，
   提取层帧时管线 CSS 会强制显示。**新层名必须加进** `asset-manifest.ts` 的
   `DEVICE_LAYER_WHITELIST.exact`（现有: logo / logo-glow / status）。
4. 帧产物: 主帧 `${texture}` + 各层帧 `${texture}/${层名}`（如 `depot`、`depot/status`）。

### 清单与定义

- `DEVICE_FILES` 加文件名——**按 basename 匹配**（LOGO/ 子目录的文件不用带目录前缀）。
- 定义: `baseStyle` **缺省**（whole 路径）；`texture` = 主帧 key；`logoTextureKey`
  可指向**独立 LOGO 文件**的帧——单层 LOGO 即可，glow 帧缺失自动无害跳过。
- **高亮白 LOGO**: 深色源无法用 tint 提亮（乘法染色只会变暗），做 `_white` 后缀的
  白色变体文件（如 `Depot_Loader_logo_white.svg`，fill 改 #ffffff）——Status 高亮时
  RenderSystem 自动换白、退出自动换回；无变体帧则高亮时保持原 LOGO（降级无害）。
  ⚠️ logoMain 继承 glow 父 tint（常态 #494848）——仓库口模式里 RenderSystem 已把
  无 glow 层设备的父 tint 固定提白（LOGO 按素材原色渲染），新整图设备自动受益。

### 免费获得的运行时行为（零代码，帧存在即生效）

- **创建模式悬停高亮**: `${texture}/status` 帧存在 → RenderSystem 自动在设备子树内
  渲染 Status 面板（设备纹理之上、LOGO 之下）——有输出口的设备创建模式**常显蓝
  #80BEE9**、悬停淡蓝 #A8D4F5；只有输入口的设备悬停其输入格时淡蓝。
- **常态外观**: status 层 display:none 不进主帧——常态的静态面板直接画进
  layer-base（如 Depot 中格的 #d3d3d3 灰面板，同时填掉 base 造型的中格镂空）。

### 特殊约束与模式

- **非正方形占地只能 0°/180°**: rotatePort 旋转数学仅对方形自洽（A3 §6 旋转不换
  占地），90° 会把端口旋出占地。`RotationPolicy` 已自动把非正方形设备的 R 键限制为
  两档——无需任何代码，但**不要**画依赖 90° 朝向的外观。
- **非生产设备**（无限源/汇）: def 加 `depot: 'unload' | 'load'` + MachineSystem
  `updateDepot` 分支 + 纯逻辑 ops（先例 `DepotOps.ts`: emitSourceToBelt /
  tryAbsorbHeadItemSink）；**四类槽位全 0**（T2.9 读数自动隐藏、createBufferSlots(0)=[]）；
  专属事件只进 recentEvents 不转发控制台（持续吞吐会刷屏）。产出物品配置留待
  T2.15 设备弹窗。

### 验收

`scripts/verify-t212-browser.mjs` 是整图设备玩家流验收模板（Playwright 真实键鼠:
工具栏放置 → E 模式画带 → 物流观察 → 选中读数 → R 两档 → 悬停高亮）；
单帧内容用 sharp 按 `devices.json` 的 `frame.x/y` 抠图逐像素检查（注意
`spriteSourceSize.x/y` 是原画布内偏移、不是图集坐标）。

## 4. 改 kit 本身（端口皮肤/装饰条/底座样式）——低频

- 端口/装饰元件都住在 `src/assets/svg/nineslice_unit.svg` 的对应组
  （slice-* 9 / port-* 6 / emblazon-* 4 / lport-* 8 / deco-l/r，S1 §9.2）。
- 改完必须跑 `node scripts/verify-t1.11-nineslice.mjs`（3×3 拼装 vs 原素材
  逐像素 0 差异基线）+ `npm run pack-assets` + `verify-t1.12-portvariant.mjs`。
- 新风格端口皮肤: 另建 `nineslice_port_xxx.svg` 按同规范切组（S3 §3.3 预留），
  运行时按设备类别选皮肤——待第一个真实需求出现再定。

### 新底座风格 kit（整套造型的第二套九宫格）

画法完全沿用现有规矩（同规格画布、每组画在自己格内、越界 ≤4px 否则调该组
marginPx、平铺 ε 重叠防缝、端口方向约定不变）；中间行可空心也可填实（c 块
有内容即正常打包平铺）；造型可圆角/切角（视觉非矩形没问题，但**占地永远是
矩形格子**——L 形等不规则占地不支持）。注意旋转 90° 后的造型是否可接受，
否则画四向对称。

落地需要一次性"皮肤化"扩展（S3 §3.3 预留思路，待第一套新风格立项时实施）:
1. 新 kit SVG（如 `nineslice_industrial.svg`，25 组同结构）+ 同规格 3×3 参考图
   （逐像素 0 差异验收基线用，角色同 3x3_unit.svg）；
2. 管线: NINESLICE_FILES 加文件 + extractNinesliceSlices 提取键加前缀
   （如 `nineslice/industrial/tl`）；
3. 运行时: buildNineSliceBase/Ports 与烘焙缓存键加 skin 参数，def 加
   `baseSkin` 字段（缺省 = 现在这套）；
4. 验收: 复制 verify-t1.11 模式对新 kit vs 其参考图跑 0 差异。
掩码派生/emblazon/deco 规则/烘焙机制与皮肤正交，无需改动。

## 5. 已知边界（别踩）

- **1×n / n×1 设备**（如 Depot）不进 nineslice 体系，走 `baseStyle` 缺省的
  whole 整图路径——完整配方见 **§3**（图层命名硬规矩 / Status 帧悬停高亮 /
  白 LOGO 变体 / 非正方形两档旋转 / 非生产设备模式）。
- **端口高亮**分两档: T2.8 连接黄/堵塞红消费设备 SVG 的 `port-*`/`arrow-*` 隐藏层
  （nineslice 设备）；整图设备走 §3 的 `${texture}/status` 帧创建模式悬停（连接/
  堵塞语义对永不堵塞的仓库口不适用）。纯 kit 设备（无自有 SVG）两者皆无，
  kit 白帧泛化是预留后置任务（S3 §7.2）。
- **顶/底液体口**同 §1 末尾，等 A3 数据模型。
- 设备 SVG 若画了 `#828080` 描边 `fill:none` 的 path 会被打进 arrow_mask 帧
  （PreviewTintFilter 契约），nineslice 设备不消费它，无碍但别误配。
- **工具栏图标是整图等比缩略**: 3:1 等长条设备受按钮 80% 长边约束会很小
  （T2.12 已知外观项，待反馈后可改用 logo 帧作图标）。

## 6. 相关文档

- `doc/asset-drawing-standard.md` §9——nineslice 素材规范（组结构/窗口边距）
- `doc/nineslice-port-variant.md`（S3）——端口掩码派生规则与验收记录
- `doc/nine-slice-device-base.md`（S2)——底座体系
- `doc/architecture/building-spec.md`（A3）——BuildingDefinition/Port 数据模型
- `doc/implementation-phase-2.md` T2.12 实现笔记——整图设备先例全记录
  （DepotOps / Status 帧 / 白 LOGO / RotationPolicy）
- 验收脚本模式: `scripts/verify-t1.12-runtime.mjs`（CDP 像素探针）、
  `verify-t1.12-visual.mjs`（截图）、`verify-t212-browser.mjs`（整图设备玩家流）、
  `verify-t212-depot.ts`（单测）
