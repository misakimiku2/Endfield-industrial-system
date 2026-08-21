// 资产清单 — 打包脚本的"单一真相源"
// 依据: DD-008(revised) 设备/UI 用 SVG、物品用 PNG；DD-013 每逻辑分组一图集
//
// 改资产分组只改这里，不动 packer / pack-assets 逻辑。
// 三个图集: devices(地图建筑)、items(物品图标)、ui(界面部件)。
// 超大文件(logo / 设计母文件)排除，单独按需加载。

/** 单个图集分组的定义。 */
export interface AtlasGroup {
  /** 图集名，也即 bundle 名 (Assets.loadBundle)、JSON/PNG 文件名前缀。 */
  name: 'devices' | 'items' | 'ui';
  /** 输入目录(相对项目根)。脚本递归扫描其下所有 svg/png。 */
  inputDir: string;
  /**
   * texture key 映射覆盖表: 源文件名(含扩展名) → 规范 texture key。
   * 未在此表中的文件走自动规则(文件名去扩展名 → 小写 → 空格/特殊符替 _)。
   * 这里的覆盖来自 building-spec.md / logistics-spec.md 指定的 texture key。
   */
  keyOverrides?: Record<string, string>;
  /**
   * SVG 光栅化倍率（**仅对 SVG 源生效**，PNG 源忽略）。
   * 地图设备会随相机 zoom 放大显示，若纹理按 1:1 原始尺寸栅格化（1×1 设备仅 64×64 像素），
   * zoom=4 时被放大 4 倍会模糊锯齿。devices 用 4× 栅格化，匹配 CAMERA_ZOOM_MAX=4.0，
   * 保证最大缩放下纹素:屏幕像素 ≈ 1:1。
   *
   * - devices: 4（地图建筑，受 zoom 影响，矢量可无损提倍）
   * - items: 不填(=1)（物品图标用于 UI 固定尺寸，源是 PNG 无矢量）
   * - ui: 不填(=1)（界面部件屏幕空间固定尺寸渲染，提倍无意义）
   *
   * ⚠️ 若未来 CAMERA_ZOOM_MAX 调高，DEVICE_RASTER_SCALE 需同步（见下常量）。
   */
  rasterScale?: number;
}

/**
 * devices 图集 SVG 光栅化倍率（单一真相源）。
 * 取值 = CAMERA_ZOOM_MAX (src/game/render/constants.ts)，保证最大缩放下纹素:屏幕像素 ≈ 1:1，
 * 设备图标在 zoom=4 时无放大锯齿。
 *
 * ⚠️ 若未来 CAMERA_ZOOM_MAX 调高，此处需同步（否则最大 zoom 仍会放大超采样模糊）。
 *    items/ui 图集不受此影响（前者源是 PNG、后者屏幕空间固定尺寸）。
 */
export const DEVICE_RASTER_SCALE = 4;

/** 三个图集分组。 */
export const ATLAS_GROUPS: AtlasGroup[] = [
  {
    name: 'devices',
    inputDir: 'src/assets/svg',
    // 地图设备随 zoom 放大显示，按 4× 栅格化匹配 CAMERA_ZOOM_MAX=4.0（纹素 1:1 无锯齿）。
    rasterScale: DEVICE_RASTER_SCALE,
    keyOverrides: {
      // building-spec / logistics-spec 指定的 texture key
      '3x3_unit.svg': '3x3_unit', // 通用 3×3 底座（不含设备专属装饰）
      'refining_unit.svg': 'refining_unit', // 精炼炉完整外观（底座 + 专属 equipment）
      'Transport_Belt_Move.svg': 'transport_belt',
      'Transport_Belt_rotate.svg': 'belt_corner',
      'Item_Control_Port.svg': 'item_control_port',
      // T2.8 状态徽标（billboard LOGO 按设备状态切换: paused/blocked）
      'Pause_Logo.svg': 'pause_logo', // 深灰暂停图标（画布与 refining_unit.svg 同尺寸，居中 ~40%）
      'Blocked_Logo.svg': 'blocked_logo', // 红 X 图标（输出满、结算暂缓）
    },
  },
  {
    name: 'items',
    // 物品 PNG 跨两个目录: AIC Products(产物) + Natural Resources(原料)
    inputDir: 'src/assets/png',
    // 物品 texture key = 文件名小写(Cuprium_Ore.png → cuprium_ore)，自动规则即可
  },
  {
    name: 'ui',
    inputDir: 'src/assets/svg', // UI 和 devices 共用 svg 目录，靠白名单分流
    keyOverrides: {
      'rect79.svg': 'refining_unit_logo', // rect79 实际是精炼炉 LOGO，去重命名
    },
  },
];

/**
 * devices 图集只收设备纹理(放地图上的)；ui 图集只收界面部件。
 * 因为它们共用 src/assets/svg/ 目录，需要按文件名白名单分流。
 * items 图集独占 src/assets/png/，无需白名单(全收)。
 */
export const DEVICE_FILES: readonly string[] = [
  // 地图建筑纹理(尺寸规整: 1×1=64, 3×3=192, 3×1=192×64)
  '3x3_unit.svg',
  'refining_unit.svg',
  'Belt_Bridge.svg',
  'Converger.svg',
  'Depot.svg',
  'Item_Control_Port.svg',
  'Splitter.svg',
  'Transport_Belt_Move.svg',
  'Transport_Belt_rotate.svg',
  'pointer.svg',
  // T2.8 状态徽标（billboard LOGO 状态切换用，随设备层 4× 栅格化）
  'Pause_Logo.svg',
  'Blocked_Logo.svg',
  // T1.11 九宫格底座切片源（不输出主帧，只输出 nineslice/* 9 切片帧，见 NINESLICE_FILES）
  'nineslice_unit.svg',
];

/**
 * 九宫格底座切片源文件白名单（T1.11b，方案 S2；T1.12 端口拆层，方案 S3）。
 * 这些文件**不输出整机主帧**——pack-assets 对源内每个组（slice-* 9 组 +
 * port-* 6 组 + lport-* 8 组 + deco-l/deco-r，S3 §3/§4）按其所在格
 * ±NINESLICE_MARGIN_SRC_PX（deco 组 ±NINESLICE_DECO_MARGIN_SRC_PX）的窗口
 * 光栅化，输出 `nineslice/<组名>` 帧（全透明的组如中心 c 块跳过）。
 * 运行时由 NineSliceAssembler 按 footprint + 端口掩码平铺/叠加。
 */
export const NINESLICE_FILES: readonly string[] = ['nineslice_unit.svg'];

/**
 * 切片提取的窗口边距（源像素）。切片内容允许越出自己格子（柱子突出、
 * 边框带切分重叠 0.3 单位≈1.13px、B 形柱左探 0.99 单位≈3.75px），
 * 窗口 = 64px 格 + 每边 4px 边距 = 72px 源（4× 光栅化后 288²）。
 * 运行时每个切片/端口 Sprite 覆盖 72×72 世界像素、中心对齐格中心。
 */
export const NINESLICE_MARGIN_SRC_PX = 4;

/**
 * deco-*（侧边装饰条）组的提取窗口边距（源像素，T1.12，S3 §3.4）。
 * 装饰条帽端斜切越出格界 1.8765 单位（≈7.1px）> 标准边距 1.0583 单位（4px），
 * 窗口放大到 64px 格 + 每边 8px = 80px 源（4× 光栅化后 320²），帽端随窗口
 * 保留——相邻行平铺时不透明同色重叠（各越界 1.88，重叠带 4.24 单位）合并为
 * 连续饰条。运行时 deco Sprite 覆盖 80×80 世界像素（NINESLICE_DECO_SPAN）。
 */
export const NINESLICE_DECO_MARGIN_SRC_PX = 8;

/**
 * 设备 SVG 功能层帧白名单（T1.11b 瘦身，S2 §4.2）。
 * base/ports/arrows/indicators/equipment 整层帧运行时无人消费（用的是主帧整图 +
 * 逐端口小帧），打包即浪费（每帧全画布占位）。只保留运行时实际消费的层：
 *   - logo / logo-glow: billboard 徽标双层（RenderSystem T2.8）
 *   - port-* / arrow-*: 逐端口面板/箭头帧（PortHighlightRenderer T2.8）
 *   - state-*: 预留未来状态层
 */
export const DEVICE_LAYER_WHITELIST: { exact: readonly string[]; prefixes: readonly string[] } = {
  exact: ['logo', 'logo-glow'],
  prefixes: ['port-', 'arrow-', 'state-'],
};

/** 判断功能层名是否在打包白名单内（layer- 后的名字，如 'port-in-0'）。 */
export function isLayerWhitelisted(layerName: string): boolean {
  return (
    DEVICE_LAYER_WHITELIST.exact.includes(layerName) ||
    DEVICE_LAYER_WHITELIST.prefixes.some((p) => layerName.startsWith(p))
  );
}

/**
 * UI 部件白名单(src/assets/svg/ 中属于 UI 的文件 + png/window/Close_button.svg)。
 * = svg 目录里除 DEVICE_FILES 外的全部 + Close_button。
 * 脚本动态计算(svg 目录下非 device 即 ui)，这里不再硬编码列表，避免维护漂移。
 */

/** 排除列表: 超大 logo / 设计母文件 / 被设备组合引用的源文件，不进任何图集(单独按需加载)。 */
export const EXCLUDE_FILES: readonly string[] = [
  'endfield-industries.svg', // 512×512 标题 logo
  'endfield-logo-zh.svg', // 1648×512 中文标题 logo
  '弹窗设计.svg', // 2000×980 设计母文件
  'Refining_Unit_Logo.svg', // 已作为 refining_unit.svg 的 layer-equipment 一部分被组合使用，不再单独打包
];

/**
 * 图集最大边长(POT)。
 * 4096：WebGL2 安全上限。T1.11 后 devices 图集已瘦身——九宫格底座（9 帧 288²，
 * 与设备尺寸解耦）+ 层帧白名单（砍掉无人消费的 base/ports/arrows/indicators/
 * equipment 整层帧）+ 层帧 trim（裁掉 alpha bounds 外透明，逐端口帧从全画布
 * 768² 缩到实际内容大小）——总量 < 10M，4096²（16.7M）足够。
 * （T2.8 期间曾临时扩到 8192，T1.11b 回落，兼容性最稳。）
 */
export const MAX_ATLAS_SIZE = 4096;

/**
 * 图集中每个图块之间的 padding(像素)，避免纹理采样溢出(bleeding)。
 *
 * 取值 8（原 2）: 图集源已开启 mipmap（见 AssetsLoader.ATLAS_TEXTURE_OPTIONS），缩小时 GPU
 * 采样低层级 mipmap，相邻图块会互相渗透（bleeding）。mipmap 每降一级边长减半，padding 8 在
 * level 1 等效 4px、level 2 等效 2px，配合子帧自身在低层级已大幅缩小，邻居渗透视觉可忽略。
 * 原 2px 在 mipmap level 1+ 即不足，会导致缩小时图块边缘渗入邻居颜色。
 */
export const ATLAS_PADDING = 8;

/** 产物输出目录(相对项目根)。Vite 自动 serve public/ 下的静态文件。 */
export const OUTPUT_DIR = 'public/spritesheets';

/** 判断一个 svg 文件是否属于 devices 图集。 */
export function isDeviceFile(basename: string): boolean {
  return DEVICE_FILES.includes(basename);
}

/** 判断一个文件是否在排除列表中。 */
export function isExcluded(basename: string): boolean {
  return EXCLUDE_FILES.includes(basename);
}
