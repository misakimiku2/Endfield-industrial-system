// 建筑定义数据表 — 数据驱动 (DD-003)
// 依据: A3 building-spec.md §1 (BuildingDefinition)、§1.1 (首批设备)、§2.1 (Port)
//
// 所有建筑类型由数据对象描述，不由 Class 定义 (DD-003)。新增建筑只需加一条记录。
// Definition 是只读静态数据，不引用任何运行时 Entity ID (DD-005)，可序列化/缓存。
//
// 字段说明:
//   - footprint/ports/selectable/texture: Phase 1 放置系统就用 (T1.7)
//   - buildCost/powerConsumption/inputSlotCount/outputSlotCount/bufferCapacity:
//     Phase 2 生产系统才用，Phase 1 照填 (A3 §1.1 都给了值)，避免 Phase 2 再补表。

/** 建筑分类 (A3 §1)。 */
export type BuildingCategory =
  | 'extraction'   // 采矿类
  | 'production'   // 生产类（精炼炉、粉碎机）
  | 'logistics'    // 物流类（传送带、分流器）
  | 'defense'      // 防御类（炮塔）
  | 'agriculture'; // 农业类（种植机、采种机）

/** 建造费用条目 (A3 §1)。Phase 1 不实现成本约束，数据照填备用。 */
export interface CostEntry {
  itemId: string;
  count: number;
}

/** 端口类型 (A3 §2.1)。liquid 端口 Phase 2+ 实现。 */
export type PortType = 'input' | 'output' | 'liquid';

/**
 * 端口定义 (A3 §2.1)。
 * position.dx/dy 是相对建筑左上角(footprint 西北角)所在 Cell 的 Grid 偏移量，
 * 默认方向(0°)下的值。方向旋转时 Port 位置跟随旋转 (A3 §2.2)，Phase 1 不实现旋转 Port 视觉。
 */
export interface Port {
  type: PortType;
  position: { dx: number; dy: number };
  /** 可选物品白名单（按 category 或 itemId），Phase 2+ 用。 */
  itemFilter?: string[];
}

/** 占地面尺寸（单位 Cell）。正方形/矩形均可，旋转后占地不变 (A3 §6)。 */
export interface Footprint {
  w: number;
  h: number;
}

/**
 * 建筑定义 (A3 §1)。运行时只读，不可修改 (A3 §6)。
 */
export interface BuildingDefinition {
  /** 唯一标识: "refining_unit", "shredding_unit" */
  id: string;
  /** 显示名称: "精炼炉" */
  name: string;
  /** 分类 */
  category: BuildingCategory;
  /** 占地面 (单位 Cell) */
  footprint: Footprint;
  /** 输入/输出口（默认方向 0° 下的位置，A3 §2） */
  ports: Port[];
  /**
   * 纹理图集 key（devices 图集内的 texture key）。
   * baseStyle='nineslice' 时语义 = equipment 专属层帧 key（透明底纯设备内容，
   * 底座由 nineslice/* 9 切片拼装，见 S1 §9）；'whole'/缺省 = 整机外观帧。
   */
  texture: string;
  /**
   * 底座渲染方式（T1.11，S2）。缺省 'whole' = 现状整图（向后兼容，已放置设备
   * 零迁移成本）。'nineslice' = 底座走 NineSliceAssembler 拼装，图集面积与
   * 设备尺寸解耦（w,h ≥ 2 的设备适用；1×n/n×1 仍走 whole）。
   */
  baseStyle?: 'whole' | 'nineslice';
  /** 可选： billboard 徽标层 key，会叠加在主体上方并保持屏幕朝上 (devices 图集内的 texture key) */
  logoTextureKey?: string;
  /** 是否可被玩家选中 (T1.8 用) */
  selectable: boolean;
  /** 建造成本 (Phase 1 不实现成本约束，A3 §1 后期功能) */
  buildCost: CostEntry[];
  /** 耗电峰值 (单位 W)。Phase 3+ 电力系统用。 */
  powerConsumption: number;
  /** 固体输入槽位数（每槽锁一种物品，A3 §3.1）。Phase 2 用。 */
  inputSlotCount: number;
  /** 固体输出槽位数（一槽一物，A3 §3.1）。Phase 2 用。 */
  outputSlotCount: number;
  /** 每个槽位的容量上限，默认 50 (A3 §1)。Phase 2 用。 */
  bufferCapacity: number;
}

/**
 * 首批设备定义表 (A3 §1.1)。
 *
> 占位 itemId 说明 (A3 §1)：buildCost 引用的 stone/iron_plate 是占位 itemId，
> 这两个物品目前未在 A4 §1.1 定义。建造成本扣除是后期功能 (Phase 1/2 不实现)，
> 待 items.csv 物品总表建立后用真实 itemId 替换。
 *
> 纹理缺口 (T1.3 备注)：shredding_unit/fitting_unit/moulding_unit/seed_picking_unit/
> planting_unit 缺 SVG，T1.7 工具栏对这些设备用程序化 Graphics 占位图（见 InventoryUI）。
> 补 SVG 后只需重跑 pack-assets，definition 的 texture key 不变。
 */
export const BUILDING_DEFINITIONS: Record<string, BuildingDefinition> = {
  refining_unit: {
    id: 'refining_unit',
    name: '精炼炉',
    category: 'production',
    footprint: { w: 3, h: 3 },
    ports: [
      // 底部一排: 输入端口
      { type: 'input', position: { dx: 0, dy: 2 } },
      { type: 'input', position: { dx: 1, dy: 2 } },
      { type: 'input', position: { dx: 2, dy: 2 } },
      // 顶部一排: 输出端口
      { type: 'output', position: { dx: 0, dy: 0 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
      // 中间层: 液体端口 (Phase 2+ 实现)
      { type: 'liquid', position: { dx: 0, dy: 1 } },
      { type: 'liquid', position: { dx: 2, dy: 1 } },
    ],
    texture: 'refining_unit',
    baseStyle: 'nineslice',
    logoTextureKey: 'refining_unit/logo',
    selectable: true,
    buildCost: [{ itemId: 'stone', count: 5 }],
    powerConsumption: 5,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },

  shredding_unit: {
    id: 'shredding_unit',
    name: '粉碎机',
    category: 'production',
    footprint: { w: 3, h: 3 },
    ports: [
      { type: 'input', position: { dx: 0, dy: 2 } },
      { type: 'input', position: { dx: 1, dy: 2 } },
      { type: 'input', position: { dx: 2, dy: 2 } },
      { type: 'output', position: { dx: 0, dy: 0 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
    ],
    texture: 'shredding_unit',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 8 }],
    powerConsumption: 5,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },

  fitting_unit: {
    id: 'fitting_unit',
    name: '配件机',
    category: 'production',
    footprint: { w: 3, h: 3 },
    ports: [
      { type: 'input', position: { dx: 0, dy: 2 } },
      { type: 'input', position: { dx: 1, dy: 2 } },
      { type: 'input', position: { dx: 2, dy: 2 } },
      { type: 'output', position: { dx: 0, dy: 0 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
    ],
    texture: 'fitting_unit',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 12 }],
    powerConsumption: 20,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },

  moulding_unit: {
    id: 'moulding_unit',
    name: '塑形机',
    category: 'production',
    footprint: { w: 3, h: 3 },
    ports: [
      { type: 'input', position: { dx: 0, dy: 2 } },
      { type: 'input', position: { dx: 1, dy: 2 } },
      { type: 'input', position: { dx: 2, dy: 2 } },
      { type: 'output', position: { dx: 0, dy: 0 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
    ],
    texture: 'moulding_unit',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 10 }],
    powerConsumption: 10,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },

  seed_picking_unit: {
    id: 'seed_picking_unit',
    name: '采种机',
    category: 'agriculture',
    footprint: { w: 5, h: 5 },
    ports: [
      // 底部一行: 输入端口
      { type: 'input', position: { dx: 1, dy: 4 } },
      { type: 'input', position: { dx: 2, dy: 4 } },
      { type: 'input', position: { dx: 3, dy: 4 } },
      // 顶部一行: 输出端口
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
      { type: 'output', position: { dx: 3, dy: 0 } },
    ],
    texture: 'seed_picking_unit',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 15 }],
    powerConsumption: 10,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },

  planting_unit: {
    id: 'planting_unit',
    name: '种植机',
    category: 'agriculture',
    footprint: { w: 5, h: 5 },
    ports: [
      { type: 'input', position: { dx: 1, dy: 4 } },
      { type: 'input', position: { dx: 2, dy: 4 } },
      { type: 'input', position: { dx: 3, dy: 4 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
      { type: 'output', position: { dx: 3, dy: 0 } },
    ],
    texture: 'planting_unit',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 15 }],
    powerConsumption: 20,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },

  // ── T1.11 九宫格验收 demo 设备（S2 §8-2 任意尺寸正确性）──
  // 不进 TOOLBAR、无 SVG equipment（texture 帧不存在 → 仅渲染底座拼装，
  // RenderSystem/PlacementSystem 对缺失 equip 帧天然跳过）。仅供
  // __game.placeAt('test_nineslice_*', gx, gy, dir) 程序化验收：
  // 边框完整一圈、柱子钉在每条内部竖格线端部、无平铺接缝、旋转后正确。
  test_nineslice_6x3: {
    id: 'test_nineslice_6x3',
    name: '九宫格6×3',
    category: 'production',
    footprint: { w: 6, h: 3 },
    ports: [
      { type: 'input', position: { dx: 2, dy: 2 } },
      { type: 'output', position: { dx: 3, dy: 0 } },
    ],
    texture: 'test_nineslice_6x3',
    baseStyle: 'nineslice',
    selectable: true,
    buildCost: [{ itemId: 'stone', count: 1 }], // 名义占位（验收 demo 设备，无经济语义）
    powerConsumption: 0,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },
  test_nineslice_5x5: {
    id: 'test_nineslice_5x5',
    name: '九宫格5×5',
    category: 'production',
    footprint: { w: 5, h: 5 },
    ports: [
      { type: 'input', position: { dx: 2, dy: 4 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
    ],
    texture: 'test_nineslice_5x5',
    baseStyle: 'nineslice',
    selectable: true,
    buildCost: [{ itemId: 'stone', count: 1 }], // 名义占位（验收 demo 设备，无经济语义）
    powerConsumption: 0,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },
  test_nineslice_6x6: {
    id: 'test_nineslice_6x6',
    name: '九宫格6×6',
    category: 'production',
    footprint: { w: 6, h: 6 },
    ports: [
      { type: 'input', position: { dx: 3, dy: 5 } },
      { type: 'output', position: { dx: 3, dy: 0 } },
    ],
    texture: 'test_nineslice_6x6',
    baseStyle: 'nineslice',
    selectable: true,
    buildCost: [{ itemId: 'stone', count: 1 }], // 名义占位（验收 demo 设备，无经济语义）
    powerConsumption: 0,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },
};

/**
 * 工具栏展示的设备列表 (T1.7)。
 * Phase 1 选 4 个: refining_unit(3×3, 有真实纹理) + 3 个 3×3/5×5 设备。
 * 覆盖 3×3 和 5×5 两种 footprint，测试占用检查 + 接近世界边界的放置。
 * 缺 SVG 的设备由 InventoryUI 用程序化 Graphics 占位图渲染。
 */
export const TOOLBAR_BUILDINGS: readonly string[] = [
  'refining_unit',     // 3×3, 有真实纹理
  'shredding_unit',    // 3×3, 占位图
  'fitting_unit',      // 3×3, 占位图
  'seed_picking_unit', // 5×5, 占位图（大占地测试）
];

/**
 * 取建筑定义。找不到返回 undefined（调用方负责处理）。
 */
export function getBuildingDefinition(id: string): BuildingDefinition | undefined {
  return BUILDING_DEFINITIONS[id];
}
