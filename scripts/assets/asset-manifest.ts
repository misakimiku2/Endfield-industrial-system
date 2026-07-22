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
}

/** 三个图集分组。 */
export const ATLAS_GROUPS: AtlasGroup[] = [
  {
    name: 'devices',
    inputDir: 'src/assets/svg',
    keyOverrides: {
      // building-spec / logistics-spec 指定的 texture key
      '3x3_unit.svg': 'refining_unit', // 3x3_unit 内容即精炼炉
      'Transport_Belt_Move.svg': 'transport_belt',
      'Transport_Belt_rotate.svg': 'belt_corner',
      'Item_Control_Port.svg': 'item_control_port',
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
  'Belt_Bridge.svg',
  'Converger.svg',
  'Depot.svg',
  'Item_Control_Port.svg',
  'Splitter.svg',
  'Transport_Belt_Move.svg',
  'Transport_Belt_rotate.svg',
  'pointer.svg',
];

/**
 * UI 部件白名单(src/assets/svg/ 中属于 UI 的文件 + png/window/Close_button.svg)。
 * = svg 目录里除 DEVICE_FILES 外的全部 + Close_button。
 * 脚本动态计算(svg 目录下非 device 即 ui)，这里不再硬编码列表，避免维护漂移。
 */

/** 排除列表: 超大 logo / 设计母文件，不进任何图集(单独按需加载)。 */
export const EXCLUDE_FILES: readonly string[] = [
  'endfield-industries.svg', // 512×512 标题 logo
  'endfield-logo-zh.svg', // 1648×512 中文标题 logo
  '弹窗设计.svg', // 2000×980 设计母文件
];

/**
 * 图集最大边长(POT)。
 * 4096 是 WebGL2 (PixiJS v8 默认) 的安全上限，所有现代 GPU 均支持。
 * items 图集含 93 个 254~256px 物品图标，2048² 装不下，需 4096。
 */
export const MAX_ATLAS_SIZE = 4096;

/** 图集中每个图块之间的 padding(像素)，避免纹理采样溢出(bleeding)。 */
export const ATLAS_PADDING = 2;

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
