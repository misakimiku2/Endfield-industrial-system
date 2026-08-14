// 物品定义数据 — CSV 驱动 (DD-003/DD-005)
// 依据: A4 item-spec.md §1 (ItemDefinition)、§6.4 (配表加载流程)
//
// 物品注册表由两个 CSV 源构成:
//   1. 终末地资源列表 - 自然资源.csv —— 自然资源（矿/液体/植物），列: 名称,英文ID,类别,等级,...
//   2. recipe.csv 的产物行 —— 每条配方的产物同时是一条物品定义，列: 物品名称,英文ID,类别,...
//   3. EXTRA_ITEM_DEFS —— 仅出现在"副产物"列、无独立定义行的物品（CSV 副产物列只有中文名）
//
// itemId 约定 = 英文ID 的 snake_case（与 items 图集 textureKey 一致，如 Originium Ore → originium_ore）。
// tags 按类别列派生: 类别 slug + 语义别名（ore/liquid/processed），配方类别匹配只用到这些。

/** 物品分类 (A4 §1)。 */
export type ItemCategory =
  | 'mineral_ore'
  | 'natural_liquid'
  | 'plant'
  | 'aic_products'
  | 'usable_items';

/** 物品定义 (A4 §1，运行时只读)。stackSize/texture 本阶段未用到，按约定 itemId 即 textureKey。 */
export interface ItemDefinition {
  /** 唯一标识 (snake_case 英文ID): "originium_ore", "origocrust" */
  id: string;
  /** 显示名称: "源矿", "晶体外壳" */
  name: string;
  category: ItemCategory;
  /** 标签（配方类别匹配用），含类别 slug 与语义别名 */
  tags: string[];
}

/** CSV 类别列 → ItemCategory + 语义别名 tag。 */
const CATEGORY_MAP: Record<string, { category: ItemCategory; alias?: string }> = {
  'Mineral Ore': { category: 'mineral_ore', alias: 'ore' },
  'Natural Liquid': { category: 'natural_liquid', alias: 'liquid' },
  'Plant': { category: 'plant' },
  'AIC Products': { category: 'aic_products', alias: 'processed' },
  'Usable Items': { category: 'usable_items' },
};

/** 英文ID → snake_case itemId（空格/连字符 → 下划线，去掉括号等非字母数字字符）。 */
export function slugifyItemId(enId: string): string {
  return enId.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * RFC4180 单行 CSV 切分（支持带引号字段内的逗号）。
 * 数据源 CSV 的描述列含逗号，不能用简单 split(',')。
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // 转义引号
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function defFromRow(name: string, enId: string, categoryCell: string): ItemDefinition | null {
  const mapped = CATEGORY_MAP[categoryCell];
  if (!mapped) return null; // 未知类别 → 调用方跳过并告警
  const id = slugifyItemId(enId);
  const tags = mapped.alias ? [mapped.category, mapped.alias] : [mapped.category];
  return { id, name, category: mapped.category, tags };
}

/**
 * 解析 自然资源.csv（列: 名称,英文ID,类别,等级,描述,次要描述）。
 * 未知类别的行跳过（当前数据只含 Mineral Ore / Natural Liquid / Plant）。
 */
export function parseItemCsv(csv: string): ItemDefinition[] {
  const defs: ItemDefinition[] = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [name, enId, category] = splitCsvLine(line);
    if (!name || !enId) continue;
    const def = defFromRow(name, enId, category);
    if (def) defs.push(def);
  }
  return defs;
}

/**
 * 解析 recipe.csv 的产物行（列: 物品名称,英文ID,类别,...）为物品定义。
 * 每条配方的产物（含未定义设备的配方产物，如反应池的赫铜块）都是可被引用的物品。
 */
export function productItemsFromRecipeCsv(csv: string): ItemDefinition[] {
  const defs: ItemDefinition[] = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [name, enId, category] = splitCsvLine(line);
    if (!name || !enId) continue;
    const def = defFromRow(name, enId, category);
    if (def) defs.push(def);
  }
  return defs;
}

/**
 * 仅出现在副产物列、无定义行的物品（A4 §6.1.2: 污水 Sewage）。
 * CSV 副产物列只写中文名，英文ID 在此补充。
 */
export const EXTRA_ITEM_DEFS: ItemDefinition[] = [
  { id: 'sewage', name: '污水', category: 'natural_liquid', tags: ['natural_liquid', 'liquid'] },
];

/** 物品注册表: id/中文名 双向索引 (A4 §6.4)。重复 id/名称时先注册者优先。 */
export interface ItemRegistry {
  byId: Map<string, ItemDefinition>;
  byName: Map<string, ItemDefinition>;
}

export function buildItemRegistry(defs: ItemDefinition[]): ItemRegistry {
  const byId = new Map<string, ItemDefinition>();
  const byName = new Map<string, ItemDefinition>();
  for (const def of defs) {
    if (!byId.has(def.id)) byId.set(def.id, def);
    if (!byName.has(def.name)) byName.set(def.name, def);
  }
  return { byId, byName };
}

/** 一步构建完整注册表（游戏启动/测试用）。 */
export function loadItemRegistry(resourceCsv: string, recipeCsv: string): ItemRegistry {
  return buildItemRegistry([
    ...parseItemCsv(resourceCsv),
    ...productItemsFromRecipeCsv(recipeCsv),
    ...EXTRA_ITEM_DEFS,
  ]);
}
