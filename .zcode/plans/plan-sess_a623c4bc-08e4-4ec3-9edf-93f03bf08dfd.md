# T1.3 SVG/PNG 资源管线 — 实施计划

## 背景与决策

**现状核查结论**:项目资产实际是"设备 SVG + 物品 PNG"双格式(36 个 svg + 93 个 png),与 DD-008"所有美术源文件为 SVG"产生冲突。经你确认:
- **修订 DD-008**:承认既成事实(设备 SVG / 物品 PNG),文档改为分情况表述,commit 标注 `DD-008-revise`
- **图集分组**:严格按 DD-013 分 `devices` / `items` / `ui` 三组,T1.3 一并生成全部
- **管线实现**:自写构建脚本 + `sharp`(依赖只加 sharp 一个)
- **集成方式**:独立 npm script + 预构建,产物输出到 `public/spritesheets/`,dev 时 Vite 直接 serve
- **设备纹理缺口**:T1.3 不补,留到 T1.7

---

## 资产分组(已审计确认)

| 图集 | 来源 | 文件数 | 尺寸特征 | texture key 规范 |
|---|---|---|---|---|
| **devices** | `src/assets/svg/` 设备类 | ~11 | 极规整(1×1=64px, 3×3=192px, 3×1=192×64) | 下划线小写(`transport_belt`, `splitter`, `depot`, `3x3_unit`→`refining_unit`) |
| **items** | `src/assets/png/AIC Products/` + `Natural Resources/` | ~93 | 统一 254×254 RGBA | 下划线小写(`Cuprium_Ore.png`→`cuprium_ore`) |
| **ui** | `src/assets/svg/` UI 类 + `png/window/Close_button.svg` | ~22 | 杂乱 | 下划线小写 |
| **不入图集** | `endfield-industries.svg`(512²), `endfield-logo-zh.svg`(1648×512), `弹窗设计.svg`(2000×980) | 3 | 超大 | 单独按需加载 |

**texture key 映射规则**:文件名(去扩展名)→ 全小写 → 空格/特殊字符替换为 `_` → 例:`Transport_Belt_Move.svg`→`transport_belt_move`;`AIC Products/Cuprium_Ore.png`→`cuprium_ore`。

**特殊映射(building-spec / logistics-spec 指定的 texture key,需手工覆盖)**:
- `3x3_unit.svg` → `refining_unit`(其内容就是精炼炉)
- `Transport_Belt_Move.svg` → `transport_belt`
- `Transport_Belt_rotate.svg` → `belt_corner`
- `Item_Control_Port.svg` → `item_control_port`
- 其余 1×1 物流设备按自动规则即可

---

## 实施步骤

### 步骤 1:安装 sharp + 修订 DD-008
- `npm i -D sharp`(构建时依赖,不进生产包)
- 修订 `doc/architecture/core-decisions.md` DD-008:改为"设备/UI 美术源文件为 SVG;物品图标为 PNG(美术已批量出图)。两者构建时统一打包为纹理图集"

### 步骤 2:创建资产清单配置 `scripts/assets/asset-manifest.ts`
- 定义三个图集分组的输入规则(目录 + glob + 手工 texture key 映射覆盖)
- 定义排除列表(3 个超大文件)
- 这是脚本的"单一真相源",改资产分组只改这里

### 步骤 3:创建打包器 `scripts/assets/packer.ts`
- **shelf-pack(列打包)算法**:把不同尺寸的 PNG 按高度排序,从左上角逐个横向排,排满一行换行。对 93 个 254×25254 物品 + 11 个设备 + 22 个 UI 足够
- 输出图集 PNG(用 sharp 合成)+ PixiJS spritesheet JSON
- **图集尺寸**:取 2 的幂次(POT),最大 2048×2048;若装不下则报错(Phase 1 资产量不会超)

### 步骤 4:创建光栅化+打包主脚本 `scripts/pack-assets.ts`
- **阶段 A 光栅化**:用 sharp 把 SVG 光栅化成 PNG 临时文件(处理 mm 单位 viewBox:按 viewBox 比例 + 目标像素尺寸计算 density)。设备按 footprint×64px,UI 按原始像素尺寸
- **阶段 B 打包**:对每个图集组(devices/items/ui)调用 packer,生成 `{group}.png` + `{group}.json`
- **阶段 C 输出**:写到 `public/spritesheets/`,清理临时文件
- **texture key 生成**:文件名 → 规范化 → 查手工映射覆盖表
- 注册 npm script: `"pack-assets": "tsx scripts/pack-assets.ts"`(用 esbuild bundle 方式跑,与 T1.1/T1.2 测试一致,无需额外装 tsx)→ 实际用 `node --experimental-strip-types` 或 esbuild bundle

### 步骤 5:创建运行时资源加载模块 `src/game/render/AssetsLoader.ts`
- 封装 PixiJS `Assets` API:加载三个图集 bundle(`devices`/`items`/`ui`),注册 spritesheet JSON
- 提供 `getTexture(group, key)` 统一访问入口
- 提供 `loadAll()` 在 main.ts 启动时调用

### 步骤 6:接入 main.ts + 验证
- main.ts 启动时 `await AssetsLoader.loadAll()`(在构建场景前)
- 验收(T1.3 不要求画面变化):打开浏览器控制台,执行 `Assets.get('transport_belt')` 等确认纹理存在、无 404
- 用 agent-browser 实测:console 无报错、`Assets` 缓存含三个图集的纹理

### 步骤 7:更新 .gitignore + 文档
- `public/spritesheets/` 加入 .gitignore(构建产物不入库)
- 更新 `doc/phase-docs-index.md` 或留 TODO 说明设备纹理缺口

---

## spritesheet JSON 格式(PixiJS v8,已确认)
```json
{
  "frames": {
    "transport_belt.png": { "frame": {"x":0,"y":0,"w":64,"h":64}, "sourceSize":{"w":64,"h":64} }
  },
  "meta": { "image": "devices.png", "format": "RGBA8888", "scale": 1 }
}
```

---

## 不做(明确排除)
- 多分辨率 mip(Phase 1 只 1×)
- 设备纹理补全(T1.7 处理)
- WebP/AVIF 压缩(留到性能优化)
- Vite 插件 HMR(过度工程)
- 大 logo 入图集(单独按需加载)

---

## 风险与验证
- **sharp 在 Windows 的兼容性**:sharp 有预编译二进制,npm install 自动选,通常无问题;若失败有备选(`@resvg/resvg-js` 做纯 JS SVG 光栅化)
- **mm 单位 viewBox 光栅化**:脚本里按 `targetPx / viewBoxUnitCount` 计算 sharp 的 `density`,需测试 3x3_unit.svg(50.8mm→192px)渲染正确
- **图集超尺寸**:Phase 1 资产总量(device 11 + item 93 + ui 22)用 2048² 足够;packer 会在超限时抛错提醒

## 验收标准(T1.3 原文)
- 你看不到画面变化
- AI 在浏览器控制台确认纹理加载成功、无 404
- `Assets.get('texture_name')` 能取到设备/物品/UI 纹理