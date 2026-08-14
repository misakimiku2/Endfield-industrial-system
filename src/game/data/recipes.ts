// 配方数据 — CSV 驱动 (DD-003/DD-005)
// 依据: A4 item-spec.md §6 (Recipe 数据模型/或与和语义/副产物)、A8 §5 (配方系统引用)
//
// 加载流程 (A4 §6.4):
//   recipe.csv → Parse rows → 解析原料(+ → 和组, / → 组内或) → 逐行校验
//   → 设备未定义 / 原料物品缺失 → warn + 跳过该配方
//   → buildRecipeIndex: Map<equipmentId, Recipe[]> 供 BuildingComponent 查询
//
// 配方 id 格式: "recipe_{equipmentId}_{主产物ItemId}_{序号}" (A4 §6.1)。
// 同一主产物可有多条配方（不同设备/不同原料），序号按加载顺序递增。

import { splitCsvLine, slugifyItemId, type ItemRegistry } from './items.ts';

/** 原料原子: 具体物品或类别匹配 (A4 §6.1)。 */
export interface RecipeAtom {
  kind: 'item' | 'tag';
  /** kind='item' 时是 itemId；kind='tag' 时是 tag 名（如 'plant'） */
  ref: string;
  count: number;
}

/** 单个原料需求: alternatives 长度=1 为确定需求，>1 为任选其一（或）(A4 §6.1.1)。 */
export interface RecipeInput {
  alternatives: RecipeAtom[];
}

/** 产物项: 主产物或副产物 (A4 §6.1.2)。 */
export interface RecipeOutput {
  itemId: string;
  count: number;
}

/** 配方 (A4 §6.1)。 */
export interface Recipe {
  id: string;
  /** 产物列表，outputs[0] 是主产物 */
  outputs: RecipeOutput[];
  equipmentId: string;
  inputs: RecipeInput[];
  /** 生产时间 (ms) */
  time: number;
  level: number;
}

/** 跳过记录（加载告警用）。 */
export interface SkippedRecipe {
  /** 产物中文名（定位行） */
  product: string;
  reason: 'unknown-equipment' | 'unknown-item';
  detail: string;
}

export interface LoadRecipeResult {
  recipes: Recipe[];
  skipped: SkippedRecipe[];
}

/** "（任意Plant类别的物品）*1" → tag 原子。 */
const TAG_PATTERN = /^（任意(.+?)类别的物品）(?:\*(\d+))?$/;

/** "源矿*1" / "赫铜块*5" → { 名, 数量 }。无 *n 时数量为 1。 */
function parseNameCount(cell: string): { name: string; count: number } | null {
  const m = /^(.+?)(?:\*(\d+))?$/.exec(cell.trim());
  if (!m || !m[1]) return null;
  return { name: m[1].trim(), count: m[2] ? parseInt(m[2], 10) : 1 };
}

/**
 * 解析单个原料项为原子。中文名 → 物品原子；"（任意X类别的物品）" → tag 原子。
 * 无法解析返回 null（调用方跳过整条配方）。
 */
function parseAtom(cell: string, registry: ItemRegistry): RecipeAtom | null {
  const tagMatch = TAG_PATTERN.exec(cell.trim());
  if (tagMatch) {
    return { kind: 'tag', ref: slugifyItemId(tagMatch[1]), count: tagMatch[2] ? parseInt(tagMatch[2], 10) : 1 };
  }
  const nc = parseNameCount(cell);
  if (!nc) return null;
  const def = registry.byName.get(nc.name);
  if (!def) return null; // 物品名不在注册表 → unknown-item
  return { kind: 'item', ref: def.id, count: nc.count };
}

/**
 * 解析"原料需求"列: 先按 `+` 拆为多个 RecipeInput（和），组内按 `/` 拆 alternatives（或）。
 * 任一原子无法解析 → 返回 null（跳过整条配方）。
 */
function parseIngredientList(cell: string, registry: ItemRegistry): RecipeInput[] | null {
  const inputs: RecipeInput[] = [];
  for (const group of cell.split('+')) {
    if (!group.trim()) continue;
    const alternatives: RecipeAtom[] = [];
    for (const part of group.split('/')) {
      if (!part.trim()) continue;
      const atom = parseAtom(part, registry);
      if (!atom) return null;
      alternatives.push(atom);
    }
    if (alternatives.length > 0) inputs.push({ alternatives });
  }
  return inputs.length > 0 ? inputs : null;
}

/**
 * 解析 recipe.csv 为配方式表。
 * 列: 物品名称,英文ID,类别,等级,合成设备,原料需求,消耗时常/秒,合成数量,描述,次要描述,副产物
 *
 * 跳过规则（A4 §6.4 warn + skip）:
 *   - 合成设备不在 equipmentNameToId（该设备尚无 BuildingDefinition）
 *   - 原料/副产物中文名不在物品注册表
 */
export function parseRecipeCsv(
  csv: string,
  registry: ItemRegistry,
  equipmentNameToId: Map<string, string>,
): LoadRecipeResult {
  const recipes: Recipe[] = [];
  const skipped: SkippedRecipe[] = [];
  /** recipe id 序号: (equipmentId, 主产物) → 已出现次数 */
  const seq = new Map<string, number>();

  for (const line of csv.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    const [name, enId, , levelCell, equipment, ingredients, timeCell, outputCountCell, , , byproductCell] = cols;
    if (!name || !enId) continue;

    const equipmentId = equipmentNameToId.get(equipment);
    if (!equipmentId) {
      skipped.push({ product: name, reason: 'unknown-equipment', detail: equipment });
      continue;
    }

    const inputs = parseIngredientList(ingredients, registry);
    if (inputs === null) {
      skipped.push({ product: name, reason: 'unknown-item', detail: `原料无法解析: ${ingredients}` });
      continue;
    }

    const mainDef = registry.byName.get(name);
    if (!mainDef) {
      skipped.push({ product: name, reason: 'unknown-item', detail: `产物未注册: ${name}` });
      continue;
    }

    // 产物: 主产物 + 副产物列（副产物只支持具体物品，格式同原料项，可 `+` 分隔多个）
    const outputs: RecipeOutput[] = [{ itemId: mainDef.id, count: parseInt(outputCountCell, 10) || 1 }];
    let byproductError: string | null = null;
    if (byproductCell) {
      for (const part of byproductCell.split('+')) {
        if (!part.trim()) continue;
        const nc = parseNameCount(part);
        const def = nc ? registry.byName.get(nc.name) : undefined;
        if (!nc || !def) { byproductError = `副产物无法解析: ${part}`; break; }
        outputs.push({ itemId: def.id, count: nc.count });
      }
    }
    if (byproductError) {
      skipped.push({ product: name, reason: 'unknown-item', detail: byproductError });
      continue;
    }

    const key = `${equipmentId}:${mainDef.id}`;
    const n = seq.get(key) ?? 0;
    seq.set(key, n + 1);

    recipes.push({
      id: `recipe_${equipmentId}_${mainDef.id}_${n}`,
      outputs,
      equipmentId,
      inputs,
      time: Math.round(parseFloat(timeCell) * 1000),
      level: parseInt(levelCell, 10) || 1,
    });
  }

  return { recipes, skipped };
}

/** 构建 equipmentId → 该设备可用配方 列表 的索引 (A4 §6.4)。 */
export function buildRecipeIndex(recipes: Recipe[]): Map<string, Recipe[]> {
  const index = new Map<string, Recipe[]>();
  for (const r of recipes) {
    const list = index.get(r.equipmentId);
    if (list) list.push(r);
    else index.set(r.equipmentId, [r]);
  }
  return index;
}

/**
 * 判断一个物品是否满足某个原料需求（T2.3 原料匹配，供 T2.5 配方匹配用）。
 * - item 原子: itemId 相等
 * - tag 原子: 物品定义的 tags 包含该 tag（如任意 plant 类物品）
 * - 或关系: alternatives 任一满足即可
 */
export function itemSatisfiesInput(itemId: string, input: RecipeInput, registry: ItemRegistry): boolean {
  return input.alternatives.some((atom) => {
    if (atom.kind === 'item') return atom.ref === itemId;
    const def = registry.byId.get(itemId);
    return def !== undefined && def.tags.includes(atom.ref);
  });
}
