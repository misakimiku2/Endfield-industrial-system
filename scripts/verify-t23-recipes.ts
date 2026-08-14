// T2.3 验证: 配方数据加载（CSV 解析 + 配方索引 + 原料匹配）
// 依据: implementation-phase-2.md T2.3、A4 §6（Recipe 数据模型/或与和/副产物）、A8 §5（配方系统引用）
//
// 用法: node --experimental-strip-types scripts/verify-t23-recipes.ts
//
// 断言:
//   物品注册表:
//     1. 自然资源.csv 解析出 12 个物品（4 矿 + 2 液 + 6 植物）
//     2. 英文ID → snake_case itemId（Originium Ore → originium_ore）
//     3. tags 按类别派生（plant 类物品含 'plant'、矿含 'ore'、液体含 'liquid'）
//     4. recipe.csv 产物行进注册表（晶体外壳 origocrust、赫铜块 hetonite 跨设备产物）
//     5. 副产物 污水 sewage 在注册表（CSV 副产物列只有中文名，走补充定义表）
//   配方解析:
//     6. 93 行配方 → 6 个已定义设备共 46 条入索引，47 条因设备未定义跳过（unknown-equipment）
//     7. 无配方因原料物品无法解析而跳过（unknown-item = 0）
//     8. 精炼炉 10 条 / 粉碎机 12 条 / 配件机·塑形机·采种机·种植机各 6 条
//     9. 晶体外壳配方: 或关系 alternatives=[源矿, 晶体外壳粉末]、time=2000ms、level=2
//    10. 赤铜块配方: 和关系 inputs 长度 2、副产物 outputs[1]=污水×1
//    11. 碳块配方: 类别匹配 atom {kind:'tag', ref:'plant'}
//    12. 赫铜零件配方: 数量>1（赫铜块×5）
//    13. 所有配方 id 唯一，格式 recipe_{equipmentId}_{主产物}_{序号}
//   原料匹配 (itemSatisfiesInput):
//    14. 精确匹配: 源矿✓ 晶体外壳粉末✓ 蓝铁矿✗（或关系内任选一）
//    15. 类别匹配: 荞花✓ 柑实✓（Plant 类）源矿✗ 蓝铁块✗（非 Plant）
import { readFileSync } from 'node:fs';
import {
  parseItemCsv,
  productItemsFromRecipeCsv,
  EXTRA_ITEM_DEFS,
  buildItemRegistry,
  type ItemRegistry,
} from '../src/game/data/items.ts';
import {
  parseRecipeCsv,
  buildRecipeIndex,
  itemSatisfiesInput,
} from '../src/game/data/recipes.ts';
import { BUILDING_DEFINITIONS } from '../src/game/data/buildings.ts';

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${msg}`); }
  else {
    failed++;
    console.error(`  ❌ ${msg}\n       期望: ${JSON.stringify(expected)}\n       实际: ${JSON.stringify(actual)}`);
  }
}

const RESOURCE_CSV = readFileSync('doc/csv/终末地资源列表 - 自然资源.csv', 'utf-8');
const RECIPE_CSV = readFileSync('doc/csv/recipe.csv', 'utf-8');

// ── 物品注册表 ──
console.log('[物品注册表]');
const resourceDefs = parseItemCsv(RESOURCE_CSV);
assertEq(resourceDefs.length, 12, '1. 自然资源解析出 12 个物品');

const registry: ItemRegistry = buildItemRegistry([
  ...resourceDefs,
  ...productItemsFromRecipeCsv(RECIPE_CSV),
  ...EXTRA_ITEM_DEFS,
]);

const originiumOre = registry.byId.get('originium_ore');
assert(!!originiumOre && originiumOre.name === '源矿', '2. Originium Ore → originium_ore (snake_case)');
assertEq(registry.byName.get('源矿')?.id, 'originium_ore', '2b. 中文名反查 → originium_ore');

const buckflower = registry.byId.get('buckflower');
assert(!!buckflower && buckflower.tags.includes('plant'), '3. 荞花 tags 含 plant');
assert(!!originiumOre && originiumOre.tags.includes('ore'), '3b. 源矿 tags 含 ore');
const cleanWater = registry.byId.get('clean_water');
assert(!!cleanWater && cleanWater.tags.includes('liquid'), '3c. 清水 tags 含 liquid');

const origocrust = registry.byId.get('origocrust');
assert(!!origocrust && origocrust.name === '晶体外壳', '4. 产物 晶体外壳 → origocrust 在注册表');
assertEq(registry.byName.get('赫铜块')?.id, 'hetonite', '4b. 跨设备产物 赫铜块 → hetonite 在注册表');

const sewage = registry.byId.get('sewage');
assert(!!sewage && sewage.name === '污水', '5. 副产物 污水 → sewage 在注册表');

// ── 配方解析 ──
console.log('[配方解析]');
const equipmentNameToId = new Map<string, string>();
for (const def of Object.values(BUILDING_DEFINITIONS)) equipmentNameToId.set(def.name, def.id);

const { recipes, skipped } = parseRecipeCsv(RECIPE_CSV, registry, equipmentNameToId);
assertEq(recipes.length, 46, '6. 6 个已定义设备共 46 条配方入表');
assertEq(skipped.length, 46, '6b. 46 条配方因设备未定义跳过');
assert(skipped.every((s) => s.reason === 'unknown-equipment'), '6c. 跳过原因全部是 unknown-equipment');

assertEq(skipped.filter((s) => s.reason === 'unknown-item').length, 0, '7. 无配方因原料物品缺失跳过');

const index = buildRecipeIndex(recipes);
assertEq(index.size, 6, '8. 索引含 6 个设备');
assertEq(index.get('refining_unit')?.length ?? 0, 10, '8b. 精炼炉 10 条配方');
assertEq(index.get('shredding_unit')?.length ?? 0, 12, '8c. 粉碎机 12 条配方');
assertEq(index.get('fitting_unit')?.length ?? 0, 6, '8d. 配件机 6 条配方');
assertEq(index.get('moulding_unit')?.length ?? 0, 6, '8e. 塑形机 6 条配方');
assertEq(index.get('seed_picking_unit')?.length ?? 0, 6, '8f. 采种机 6 条配方');
assertEq(index.get('planting_unit')?.length ?? 0, 6, '8g. 种植机 6 条配方');

const furnace = index.get('refining_unit')!;
const origocrustRecipe = furnace.find((r) => r.outputs[0].itemId === 'origocrust')!;
assertEq(origocrustRecipe.id, 'recipe_refining_unit_origocrust_0', '9. 晶体外壳配方 id 格式');
assertEq(origocrustRecipe.time, 2000, '9b. 晶体外壳 time = 2000ms (2秒×1000)');
assertEq(origocrustRecipe.level, 2, '9c. 晶体外壳 level = 2');
assertEq(origocrustRecipe.outputs, [{ itemId: 'origocrust', count: 1 }], '9d. 主产物 = origocrust×1');
assertEq(origocrustRecipe.inputs.length, 1, '9e. 源矿*1/晶体外壳粉末*1 → 1 个 RecipeInput（或关系不拆组）');
assertEq(origocrustRecipe.inputs[0].alternatives, [
  { kind: 'item', ref: 'originium_ore', count: 1 },
  { kind: 'item', ref: 'origocrust_powder', count: 1 },
], '9f. alternatives = [源矿, 晶体外壳粉末]（/ = 或）');

const cupriumRecipe = furnace.find((r) => r.outputs[0].itemId === 'cuprium')!;
assertEq(cupriumRecipe.inputs.length, 2, '10. 赤铜矿*1+清水*1 → 2 个 RecipeInput（+ = 和）');
assertEq(cupriumRecipe.outputs.length, 2, '10b. 赤铜块配方有副产物 → outputs 长度 2');
assertEq(cupriumRecipe.outputs[1], { itemId: 'sewage', count: 1 }, '10c. 副产物 = 污水(sewage)×1');

const carbonRecipe = furnace.find((r) => r.outputs[0].itemId === 'carbon')!;
assertEq(carbonRecipe.inputs[0].alternatives, [
  { kind: 'tag', ref: 'plant', count: 1 },
], '11. （任意Plant类别的物品）*1 → tag atom {kind:"tag", ref:"plant"}');

const hetonitePart = index.get('fitting_unit')!.find((r) => r.outputs[0].itemId === 'hetonite_part')!;
assertEq(hetonitePart.inputs[0].alternatives[0], { kind: 'item', ref: 'hetonite', count: 5 }, '12. 赫铜块*5 → count=5');

const ids = new Set(recipes.map((r) => r.id));
assertEq(ids.size, recipes.length, '13. 所有配方 id 唯一');

// ── 原料匹配 ──
console.log('[原料匹配 itemSatisfiesInput]');
const orInput = origocrustRecipe.inputs[0];
assert(itemSatisfiesInput('originium_ore', orInput, registry), '14. 精确匹配: 源矿 满足 晶体外壳原料');
assert(itemSatisfiesInput('origocrust_powder', orInput, registry), '14b. 精确匹配: 晶体外壳粉末 满足（或关系另一分支）');
assert(!itemSatisfiesInput('ferrium_ore', orInput, registry), '14c. 蓝铁矿 不满足（不在或分支内）');

const tagInput = carbonRecipe.inputs[0];
assert(itemSatisfiesInput('buckflower', tagInput, registry), '15. 类别匹配: 荞花(plant) 满足 碳块原料');
assert(itemSatisfiesInput('citrome', tagInput, registry), '15b. 类别匹配: 柑实(plant) 满足');
assert(!itemSatisfiesInput('originium_ore', tagInput, registry), '15c. 源矿(ore) 不满足 plant 类别');
assert(!itemSatisfiesInput('origocrust', tagInput, registry), '15d. 晶体外壳(aic_products) 不满足 plant 类别');
assert(!itemSatisfiesInput('unknown_item', tagInput, registry), '15e. 未知物品安全返回 false');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
