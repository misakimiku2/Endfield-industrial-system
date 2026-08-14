// T2.5 验证: 生产计时与生产循环（配方匹配 + 计时推进 + 原子结算 + blocked 暂缓）
// 依据: implementation-phase-2.md T2.5、A8 §3（生产计时/原子结算）、§2.2（输出槽满→blocked）、§6（状态机）
//
// 用法: node --experimental-strip-types scripts/verify-t25-production.ts
//
// 断言:
//   ProductionOps 纯函数:
//     1. planRecipeInputs 精确匹配: 晶体外壳配方 + 槽[源矿×3] → 从槽0 扣源矿×1
//     2. 或关系备选: 槽[晶体外壳粉末×1] 也可匹配（alternatives 第二支）
//     3. 或关系首选优先: 槽[源矿, 晶体外壳粉末] → 选源矿（第一支先满足先用）
//     4. 数量不足 → null（合成配方 A×2，槽内仅 A×1）
//     5. 液体原料组不可满足: 赤铜块(赤铜矿+清水) + 槽[赤铜矿×5] → null（清水走 liquid 端口）
//     6. 槽内液体物品不参与匹配: 槽[赤铜矿×5, 清水×5] → 仍 null
//     7. tag 匹配: 碳块(任意Plant) + 槽[锦草×1] → 可满足
//     8. 多组和关系跨槽分配: 合成配方 A×1+B×1 → 两槽各扣 1，不超扣
//     9. findMatchingRecipe: 槽[蓝铁矿] → 蓝铁块配方；槽[源矿] → 晶体外壳配方（列表序首个匹配）
//    10. planOutputs: 空输出槽落槽0；同类合堆落同槽；满 → null
//    11. planOutputs 液体副产物跳过: 赤铜块 outputs[赤铜块, 污水] → 仅赤铜块占槽
//    12. settleProduction: 扣输入+加输出+清计时；输入扣到 0 解锁
//   MachineSystem 集成（真实 ECS World + recipe.csv 数据）:
//    13. 注入源矿×3 → 首个 Tick 启动计时（不扣原料），state=working
//    14. 计时推进期间输入槽保持 ×3（A8 §3.1 核心约束）
//    15. 2 秒（40 Tick 计时）完成 → 原子结算: 输入 -1、输出 晶体外壳 +1，同 Tick 续启下一次
//    16. 事件消息: "计时完成！原子结算：输入槽 源矿 -1，输出槽 晶体外壳 +1" / "已启动下一次生产计时"
//    17. 原料耗尽: 3 个源矿 → 3 次结算后输入空、输出 ×3、state=idle
//    18. blocked: 输出注满 50 → 计时完成但结算暂缓（原料未扣、state=blocked）
//    19. 疏通: consumeOutput(1) → 下一 Tick 完成暂缓结算（"输出疏通"前缀）并恢复 working
//    20. 液体配方不启动: 槽[赤铜矿×5]（赤铜块需清水）→ 保持 idle
//    21. 跨设备: 粉碎机 + 槽[晶体外壳×1] → 启动晶体外壳粉末配方
import { readFileSync } from 'node:fs';
import { World } from '../src/game/ECS.ts';
import {
  parseItemCsv,
  productItemsFromRecipeCsv,
  EXTRA_ITEM_DEFS,
  buildItemRegistry,
} from '../src/game/data/items.ts';
import {
  parseRecipeCsv,
  buildRecipeIndex,
  type Recipe,
  type RecipeInput,
} from '../src/game/data/recipes.ts';
import { BUILDING_DEFINITIONS } from '../src/game/data/buildings.ts';
import { createBufferSlots, tryAcceptItem, consumeFromSlot } from '../src/game/systems/machine/BufferOps.ts';
import {
  planRecipeInputs,
  findMatchingRecipe,
  planOutputs,
  settleProduction,
  isLiquidItem,
} from '../src/game/systems/machine/ProductionOps.ts';
import { MachineSystem } from '../src/game/systems/MachineSystem.ts';
import type { BuildingComp } from '../src/game/components/BuildingComp.ts';

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

// ── 数据加载（与 main.ts 相同流程）──
const RESOURCE_CSV = readFileSync('doc/csv/终末地资源列表 - 自然资源.csv', 'utf-8');
const RECIPE_CSV = readFileSync('doc/csv/recipe.csv', 'utf-8');
const registry = buildItemRegistry([
  ...parseItemCsv(RESOURCE_CSV),
  ...productItemsFromRecipeCsv(RECIPE_CSV),
  ...EXTRA_ITEM_DEFS,
]);
const equipmentNameToId = new Map<string, string>();
for (const def of Object.values(BUILDING_DEFINITIONS)) equipmentNameToId.set(def.name, def.id);
const recipeIndex = buildRecipeIndex(parseRecipeCsv(RECIPE_CSV, registry, equipmentNameToId).recipes);
const nameOf = (id: string): string => registry.byId.get(id)?.name ?? id;
const furnaceRecipes = recipeIndex.get('refining_unit')!;
const recipeOf = (equipmentId: string, mainItemId: string): Recipe =>
  (recipeIndex.get(equipmentId) ?? []).find((r) => r.outputs[0].itemId === mainItemId)!;
const inGroup = (...alts: Array<[string, number]>): RecipeInput =>
  ({ alternatives: alts.map(([ref, count]) => ({ kind: 'item' as const, ref, count })) });
/** 合成配方（纯函数测试用，绕开 CSV）。 */
const synthRecipe = (inputs: RecipeInput[], outputs: Array<[string, number]>): Recipe => ({
  id: 'recipe_synth', equipmentId: 'refining_unit',
  inputs, outputs: outputs.map(([itemId, count]) => ({ itemId, count })),
  time: 2000, level: 1,
});

// ═══════════════════ ProductionOps 纯函数 ═══════════════════
console.log('[planRecipeInputs 配方匹配]');
const rShell = recipeOf('refining_unit', 'origocrust'); // 晶体外壳(源矿/晶体外壳粉末)
assertEq(
  planRecipeInputs(rShell, [{ itemId: 'originium_ore', count: 3 }], registry),
  [{ slotIndex: 0, itemId: 'originium_ore', count: 1 }],
  '1. 精确匹配: 槽[源矿×3] → 从槽0 扣源矿×1',
);
assertEq(
  planRecipeInputs(rShell, [{ itemId: 'origocrust_powder', count: 1 }], registry),
  [{ slotIndex: 0, itemId: 'origocrust_powder', count: 1 }],
  '2. 或关系备选: 槽[晶体外壳粉末] 匹配 alternatives 第二支',
);
assertEq(
  planRecipeInputs(rShell, [
    { itemId: 'originium_ore', count: 1 },
    { itemId: 'origocrust_powder', count: 1 },
  ], registry),
  [{ slotIndex: 0, itemId: 'originium_ore', count: 1 }],
  '3. 或关系首选优先: 两支都满足 → 用第一支(源矿)',
);
const rDouble = synthRecipe([inGroup(['item_a', 2])], [['item_out', 1]]);
assertEq(
  planRecipeInputs(rDouble, [{ itemId: 'item_a', count: 1 }], registry),
  null,
  '4. 数量不足(A×2 需求, 槽内 A×1) → null',
);
const rCuprium = recipeOf('refining_unit', 'cuprium'); // 赤铜块(赤铜矿+清水 → 赤铜块+污水)
assertEq(planRecipeInputs(rCuprium, [{ itemId: 'cuprium_ore', count: 5 }], registry), null,
  '5. 液体原料组(清水)不可由固体槽满足 → null');
assertEq(planRecipeInputs(rCuprium, [
  { itemId: 'cuprium_ore', count: 5 },
  { itemId: 'clear_water', count: 5 },
], registry), null,
  '6. 槽内液体物品(清水)不参与固体匹配 → 仍 null');
assertEq(planRecipeInputs(rDouble, [{ itemId: 'item_a', count: 2 }], registry),
  [{ slotIndex: 0, itemId: 'item_a', count: 2 }],
  '6b. 数量足够时按需扣减(A×2)');
const rCarbon = furnaceRecipes.find((r) =>
  r.inputs.some((g) => g.alternatives.some((a) => a.kind === 'tag')))!; // 碳块(任意Plant)
const jincao = registry.byName.get('锦草')!;
assertEq(
  planRecipeInputs(rCarbon, [{ itemId: jincao.id, count: 1 }], registry),
  [{ slotIndex: 0, itemId: jincao.id, count: 1 }],
  `7. tag 匹配: 槽[锦草] 满足任意Plant 类别需求`,
);
assertEq(
  planRecipeInputs(
    synthRecipe([inGroup(['item_a', 1]), inGroup(['item_b', 1])], [['item_out', 1]]),
    [{ itemId: 'item_a', count: 1 }, { itemId: 'item_b', count: 1 }],
    registry,
  ),
  [
    { slotIndex: 0, itemId: 'item_a', count: 1 },
    { slotIndex: 1, itemId: 'item_b', count: 1 },
  ],
  '8. 和关系多组跨槽分配（各槽各扣 1，不超扣）',
);

console.log('[findMatchingRecipe]');
const mFerrium = findMatchingRecipe(furnaceRecipes, [{ itemId: 'ferrium_ore', count: 1 }], registry);
assert(mFerrium !== null && mFerrium.recipe.outputs[0].itemId === 'ferrium',
  '9. 槽[蓝铁矿] → 匹配蓝铁块配方');
const mOriginium = findMatchingRecipe(furnaceRecipes, [{ itemId: 'originium_ore', count: 1 }], registry);
assert(mOriginium !== null && mOriginium.recipe.id === rShell.id,
  '9b. 槽[源矿] → 匹配列表序首个（晶体外壳）');
assertEq(findMatchingRecipe(furnaceRecipes, createBufferSlots(1), registry), null,
  '9c. 全空槽 → null');
assert(findMatchingRecipe(furnaceRecipes, [{ itemId: 'amethyst_ore', count: 1 }], registry) !== null,
  '9d. 槽[紫晶矿×1] → 匹配紫晶纤维配方');

console.log('[planOutputs 产物落地]');
assertEq(
  planOutputs([{ itemId: 'origocrust', count: 1 }], createBufferSlots(1), 50, registry),
  [{ slotIndex: 0, itemId: 'origocrust', count: 1 }],
  '10. 空输出槽 → 落槽0（锁定产物类型）',
);
assertEq(
  planOutputs([{ itemId: 'origocrust', count: 1 }], [{ itemId: 'origocrust', count: 30 }], 50, registry),
  [{ slotIndex: 0, itemId: 'origocrust', count: 1 }],
  '10b. 同类产物合堆落同槽',
);
assertEq(
  planOutputs([{ itemId: 'origocrust', count: 1 }], [{ itemId: 'origocrust', count: 50 }], 50, registry),
  null,
  '10c. 输出槽满(50/50) → null（结算暂缓）',
);
const cupriumOutputs = rCuprium.outputs; // [赤铜块×1, 污水×1]
assert(isLiquidItem('sewage', registry) && !isLiquidItem('cuprium', registry),
  '11. isLiquidItem: 污水=液体、赤铜块=固体');
assertEq(
  planOutputs(cupriumOutputs, createBufferSlots(1), 50, registry),
  [{ slotIndex: 0, itemId: 'cuprium', count: 1 }],
  '11b. 液体副产物(污水)跳过，不占固体输出槽',
);

console.log('[settleProduction 原子结算]');
const comp: BuildingComp = {
  definitionId: 'refining_unit', direction: 0, state: 'working',
  bufferInput: [{ itemId: 'originium_ore', count: 1 }],
  bufferOutput: createBufferSlots(1),
  currentRecipeId: rShell.id, progress: 1, elapsed: 2000,
};
settleProduction(comp,
  [{ slotIndex: 0, itemId: 'originium_ore', count: 1 }],
  [{ slotIndex: 0, itemId: 'origocrust', count: 1 }]);
assertEq(comp.bufferInput, [{ itemId: null, count: 0 }], '12. 输入扣到 0 → 解锁');
assertEq(comp.bufferOutput, [{ itemId: 'origocrust', count: 1 }], '12b. 输出加入产物并锁定类型');
assertEq(
  { id: comp.currentRecipeId, progress: comp.progress, elapsed: comp.elapsed },
  { id: null, progress: 0, elapsed: 0 },
  '12c. 计时清空（currentRecipeId=null, progress/elapsed 归零）',
);

// ═══════════════════ MachineSystem 集成（真实 World + GameLoop 语义）═══════════════════
console.log('[MachineSystem 生产循环]');
const DT = 50; // SIM_STEP_MS (DD-004)
const world = new World();
const sys = new MachineSystem(recipeIndex, registry);
const events: string[] = [];
sys.onEvent = (e) => events.push(e.message);

/** 建一台设备（与 placeAt 相同的 Component 结构）。 */
const placeFurnace = (definitionId = 'refining_unit'): { handle: number; comp: BuildingComp } => {
  const def = BUILDING_DEFINITIONS[definitionId];
  const handle = world.createEntity();
  const comp: BuildingComp = {
    definitionId, direction: 0, state: 'idle',
    bufferInput: createBufferSlots(def.inputSlotCount),
    bufferOutput: createBufferSlots(def.outputSlotCount),
    currentRecipeId: null, progress: 0, elapsed: 0,
  };
  world.addComponent(handle, 'BuildingComp', comp);
  return { handle, comp };
};
const tick = (n = 1): void => { for (let i = 0; i < n; i++) sys.update(world, DT); };

// 13~17: 精炼炉 + 源矿×3 的完整生产循环
const f1 = placeFurnace();
for (let i = 0; i < 3; i++) tryAcceptItem(f1.comp.bufferInput, 'originium_ore', 50);
tick(); // 启动计时（不扣原料）
assert(f1.comp.state === 'working' && f1.comp.currentRecipeId === rShell.id,
  '13. 注入源矿×3 → 首个 Tick 启动计时（state=working）');
assertEq(f1.comp.bufferInput[0].count, 3, '13b. 启动计时不扣原料（仍 ×3）');
assertEq(f1.comp.elapsed, 0, '13c. 启动 Tick elapsed=0（推进从下一 Tick 开始）');

tick(38); // 累计 39 次更新: elapsed = 38×50 = 1900ms
assert(f1.comp.progress > 0 && f1.comp.progress < 1 && f1.comp.state === 'working',
  `14. 计时推进中 progress=${f1.comp.progress.toFixed(3)} < 1`);
assertEq(f1.comp.bufferInput[0].count, 3, '14b. 生产期间输入槽源矿保持 ×3（A8 §3.1）');

tick(2); // 第 41 次更新: elapsed=40×50=2000（启动后整 2 秒）→ progress=1.0 → 原子结算 + 同 Tick 续启
assertEq(f1.comp.bufferInput[0].count, 2, '15. 计时完成原子结算: 输入 源矿 -1');
assertEq(f1.comp.bufferOutput[0], { itemId: 'origocrust', count: 1 }, '15b. 输出槽 晶体外壳 +1');
assert(f1.comp.currentRecipeId === rShell.id && f1.comp.state === 'working' && f1.comp.elapsed === 0,
  '15c. 结算后同 Tick 续启下一次计时（elapsed 归零重新计）');
assert(events.some((m) => m.includes('计时完成！原子结算：输入槽 源矿 -1，输出槽 晶体外壳 +1')),
  '16. 事件消息: "计时完成！原子结算：输入槽 源矿 -1，输出槽 晶体外壳 +1"');
assert(events.some((m) => m.includes('已启动下一次生产计时')),
  '16b. 事件消息: "已启动下一次生产计时..."');

tick(82); // 两次完整计时（每次 41 次更新: 启动+40 推进），余料耗尽（总 123 次）
assertEq(f1.comp.bufferInput, [{ itemId: null, count: 0 }], '17. 3 个源矿全部消耗 → 输入空且解锁');
assertEq(f1.comp.bufferOutput[0].count, 3, '17b. 输出 晶体外壳 ×3');
assert(f1.comp.currentRecipeId === null && f1.comp.state === 'idle', '17c. 无原料 → idle，无生产任务');

// 18~19: blocked（输出满 → 结算暂缓 → 疏通）
events.length = 0;
const f2 = placeFurnace();
for (let i = 0; i < 50; i++) tryAcceptItem(f2.comp.bufferOutput, 'origocrust', 50); // 输出注满
for (let i = 0; i < 5; i++) tryAcceptItem(f2.comp.bufferInput, 'originium_ore', 50);
tick(41); // 启动 + 40 Tick 计时完成
assert(f2.comp.state === 'blocked' && f2.comp.progress === 1,
  '18. 输出满 + 计时完成 → blocked（结算暂缓）');
assertEq(f2.comp.bufferInput[0].count, 5, '18b. 暂缓期间原料未扣除（仍 ×5）');
assertEq(f2.comp.bufferOutput[0].count, 50, '18c. 输出保持 50/50');
assert(events.some((m) => m.includes('blocked') && m.includes('原料未扣除')),
  '18d. 事件消息: 输出槽已满 → blocked');

tick(5); // 暂缓期间继续 Tick，仍不结算
assert(f2.comp.state === 'blocked' && f2.comp.bufferInput[0].count === 5,
  '18e. 持续暂缓（每 Tick 重试结算，输出仍满）');

consumeFromSlot(f2.comp.bufferOutput[0], 1); // 模拟 T2.7 传送带取走 1 件
tick(); // 下一 Tick 完成暂缓结算
assert(f2.comp.state === 'working' && f2.comp.progress < 1,
  '19. 输出疏通 → 完成暂缓结算并续启（恢复 working）');
assertEq(f2.comp.bufferInput[0].count, 4, '19b. 疏通后扣源矿 ×1');
assertEq(f2.comp.bufferOutput[0].count, 50, '19c. 输出回满 50/50（49+1）');
assert(events.some((m) => m.includes('输出疏通，计时完成！原子结算')),
  '19d. 事件消息: "输出疏通，计时完成！原子结算..."');

// 20: 液体配方不启动
const f3 = placeFurnace();
for (let i = 0; i < 5; i++) tryAcceptItem(f3.comp.bufferInput, 'cuprium_ore', 50);
tick(45);
assert(f3.comp.state === 'idle' && f3.comp.currentRecipeId === null,
  '20. 槽[赤铜矿×5]（赤铜块需清水，液体端口未实现）→ 保持 idle');

// 21: 跨设备配方
const sh1 = placeFurnace('shredding_unit');
for (let i = 0; i < 2; i++) tryAcceptItem(sh1.comp.bufferInput, 'origocrust', 50);
tick();
assert(sh1.comp.state === 'working' && sh1.comp.currentRecipeId !== null
  && sh1.comp.currentRecipeId.startsWith('recipe_shredding_unit_'),
  '21. 粉碎机 + 槽[晶体外壳×2] → 启动粉碎机配方（晶体外壳粉末）');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
