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
  /**
   * 仓库口标记（T2.12）。非生产设备——无配方/无缓冲区/无生产计时：
   * 'unload' = 取货口（无限源，凭空放出 DEPOT_SOURCE_ITEM）；
   * 'load' = 存货口（无限汇，无条件吸入）。MachineSystem 据此走 DepotOps 分支。
   */
  depot?: 'unload' | 'load';
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

  // ── T2.12 简化版仓库取货口/存货口（2026-08-24 用户澄清：非生产设备，无限源/汇）──
  // 3×1 整图背景（Depot.svg 共用，whole 路径不进九宫格）；单层 billboard LOGO 居中。
  // 朝向只允许 0°/180°（非正方形占地，A3 §6 旋转不换占地 → RotationPolicy 两档）。
  // h=1 时 dy=0 行 portOutwardBase 判为顶边朝上：取货口输出口=带从上方接出（同精炼炉
  // 输出口语义）；存货口输入口=供给带从下方指入（findFeederBelt 四方向扫描）。
  depot_unloader: {
    id: 'depot_unloader',
    name: '仓库取货口',
    category: 'logistics',
    footprint: { w: 3, h: 1 },
    ports: [
      { type: 'output', position: { dx: 0, dy: 0 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
    ],
    texture: 'depot',
    logoTextureKey: 'depot_unloader_logo',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 4 }],
    powerConsumption: 0,
    inputSlotCount: 0, // 无缓冲区（无限源，凭空放出 DEPOT_SOURCE_ITEM）
    outputSlotCount: 0,
    bufferCapacity: 50, // 名义值（无槽位即无意义，保持字段必填）
    depot: 'unload',
  },
  depot_loader: {
    id: 'depot_loader',
    name: '仓库存货口',
    category: 'logistics',
    footprint: { w: 3, h: 1 },
    ports: [
      { type: 'input', position: { dx: 0, dy: 0 } },
      { type: 'input', position: { dx: 1, dy: 0 } },
      { type: 'input', position: { dx: 2, dy: 0 } },
    ],
    texture: 'depot',
    logoTextureKey: 'depot_loader_logo',
    selectable: true,
    buildCost: [{ itemId: 'iron_plate', count: 4 }],
    powerConsumption: 0,
    inputSlotCount: 0, // 无缓冲区（无限汇，无条件接受）
    outputSlotCount: 0,
    bufferCapacity: 50,
    depot: 'load',
  },

  // ── T1.11 九宫格验收 demo 设备（S2 §8-2 任意尺寸正确性）──
  // 不进 TOOLBAR、无 SVG equipment（texture 帧不存在 → 仅渲染底座拼装，
  // RenderSystem/PlacementSystem 对缺失 equip 帧天然跳过）。仅供
  // __game.placeAt('test_nineslice_*', gx, gy, dir) 程序化验收：
  // 边框完整一圈、柱子钉在每条内部竖格线端部、无平铺接缝、旋转后正确。
  test_nineslice_4x3: {
    id: 'test_nineslice_4x3',
    name: '九宫格4×3',
    category: 'production',
    footprint: { w: 4, h: 3 },
    ports: [
      { type: 'input', position: { dx: 1, dy: 2 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
    ],
    texture: 'test_nineslice_4x3',
    baseStyle: 'nineslice',
    selectable: true,
    buildCost: [{ itemId: 'stone', count: 1 }], // 名义占位（验收 demo 设备，无经济语义）
    powerConsumption: 0,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },
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

  // ── T1.12 端口变体验收 demo 设备（S3 §6，掩码从 ports 派生零美术成本）──
  // 同样不进 TOOLBAR、无 SVG equipment，仅供 __game.placeAt 程序化验收：
  //   test_nineslice_noport     → ports 空：纯底座 + 两侧 deco 装饰条（无液体口侧）
  //   test_nineslice_liquid_5x5 → 左边两行液体口 + 右边一行液体口（多行侧液口，
  //                              有液口的侧边不显示 deco）+ 中列固体顶出/底入
  //   test_nineslice_full_5x5   → 顶/底整行固体口（emblazon A/B/A/B 满排）+
  //                              无液体口 → 两侧 deco 连续饰条与满口行同屏验证
  test_nineslice_noport: {
    id: 'test_nineslice_noport',
    name: '九宫格无端口',
    category: 'production',
    footprint: { w: 3, h: 3 },
    ports: [],
    texture: 'test_nineslice_noport',
    baseStyle: 'nineslice',
    selectable: true,
    buildCost: [{ itemId: 'stone', count: 1 }], // 名义占位（验收 demo 设备，无经济语义）
    powerConsumption: 0,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },
  test_nineslice_liquid_5x5: {
    id: 'test_nineslice_liquid_5x5',
    name: '九宫格侧液口5×5',
    category: 'production',
    footprint: { w: 5, h: 5 },
    ports: [
      // 左边 dy=1、dy=3 两行液体出口，右边 dy=2 一行液体进口
      { type: 'liquid', position: { dx: 0, dy: 1 } },
      { type: 'liquid', position: { dx: 0, dy: 3 } },
      { type: 'liquid', position: { dx: 4, dy: 2 } },
      // 中列固体口做参照（顶出/底入）
      { type: 'output', position: { dx: 2, dy: 0 } },
      { type: 'input', position: { dx: 2, dy: 4 } },
    ],
    texture: 'test_nineslice_liquid_5x5',
    baseStyle: 'nineslice',
    selectable: true,
    buildCost: [{ itemId: 'stone', count: 1 }], // 名义占位（验收 demo 设备，无经济语义）
    powerConsumption: 0,
    inputSlotCount: 1,
    outputSlotCount: 1,
    bufferCapacity: 50,
  },
  test_nineslice_full_5x5: {
    id: 'test_nineslice_full_5x5',
    name: '九宫格满口5×5',
    category: 'production',
    footprint: { w: 5, h: 5 },
    ports: [
      // 顶行整行输出口 + 底行整行输出口（emblazon 每边界一颗 A/B/A/B 交替）
      { type: 'output', position: { dx: 0, dy: 0 } },
      { type: 'output', position: { dx: 1, dy: 0 } },
      { type: 'output', position: { dx: 2, dy: 0 } },
      { type: 'output', position: { dx: 3, dy: 0 } },
      { type: 'output', position: { dx: 4, dy: 0 } },
      { type: 'input', position: { dx: 0, dy: 4 } },
      { type: 'input', position: { dx: 1, dy: 4 } },
      { type: 'input', position: { dx: 2, dy: 4 } },
      { type: 'input', position: { dx: 3, dy: 4 } },
      { type: 'input', position: { dx: 4, dy: 4 } },
      // 无液体口 → 左右侧边中间行逐行 deco 装饰条（与满口行同屏验证）
    ],
    texture: 'test_nineslice_full_5x5',
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
  'depot_unloader',    // 3×1, 仓库取货口（T2.12 无限源）
  'depot_loader',      // 3×1, 仓库存货口（T2.12 无限汇）
];

/**
 * 取建筑定义。找不到返回 undefined（调用方负责处理）。
 */
export function getBuildingDefinition(id: string): BuildingDefinition | undefined {
  return BUILDING_DEFINITIONS[id];
}

/**
 * 设备的输出端口数量 (T2.10)。输出轮询队列 outputPollQueue 的容量基准——
 * 队列元素是"过滤后输出端口列表"（type==='output'，按 ports 定义序）中的下标。
 */
export function outputPortCount(def: BuildingDefinition): number {
  let n = 0;
  for (const p of def.ports) if (p.type === 'output') n++;
  return n;
}

/**
 * 创建初始输出轮询队列 (T2.10)：全部输出端口按定义序（左→中→右）活跃。
 * 放置设备时初始化 BuildingComp.outputPollQueue 用；后续轮转/堵塞/恢复由
 * MachineSystem 维护（A8 §4.2）。
 */
export function createOutputPollQueue(def: BuildingDefinition): number[] {
  return Array.from({ length: outputPortCount(def) }, (_, i) => i);
}
