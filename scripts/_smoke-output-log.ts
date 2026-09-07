// 临时冒烟: 验证 T2.25 输出诊断日志格式（跑完即删）
import { readFileSync } from 'node:fs';
import { World } from '../src/game/ECS.ts';
import {
  parseItemCsv, productItemsFromRecipeCsv, EXTRA_ITEM_DEFS, buildItemRegistry,
} from '../src/game/data/items.ts';
import { parseRecipeCsv, buildRecipeIndex } from '../src/game/data/recipes.ts';
import { BUILDING_DEFINITIONS } from '../src/game/data/buildings.ts';
import { BeltSystem } from '../src/game/systems/BeltSystem.ts';
import { MachineSystem } from '../src/game/systems/MachineSystem.ts';
import { createBufferSlots } from '../src/game/systems/machine/BufferOps.ts';
import { logisticsDebug } from '../src/game/systems/machine/LogisticsDebug.ts';
import type { BuildingComp } from '../src/game/components/BuildingComp.ts';
import type { BeltSegmentComp } from '../src/game/components/BeltSegmentComp.ts';
import { CELL_SIZE } from '../src/game/render/constants.ts';

const registry = buildItemRegistry([
  ...parseItemCsv(readFileSync('doc/csv/终末地资源列表 - 自然资源.csv', 'utf-8')),
  ...productItemsFromRecipeCsv(readFileSync('doc/csv/recipe.csv', 'utf-8')),
  ...EXTRA_ITEM_DEFS,
]);
const nameToId = new Map<string, string>();
for (const def of Object.values(BUILDING_DEFINITIONS)) nameToId.set(def.name, def.id);
const recipeIndex = buildRecipeIndex(parseRecipeCsv(readFileSync('doc/csv/recipe.csv', 'utf-8'), registry, nameToId).recipes);

const world = new World();
const beltSys = new BeltSystem();
const machineSys = new MachineSystem(recipeIndex, registry);
const f = (() => {
  const def = BUILDING_DEFINITIONS['refining_unit' as keyof typeof BUILDING_DEFINITIONS];
  const h = world.createEntity();
  world.addComponent(h, 'Position', { x: 5 * CELL_SIZE, y: 5 * CELL_SIZE });
  const comp: BuildingComp = {
    definitionId: 'refining_unit', direction: 0, state: 'idle', paused: false,
    bufferInput: createBufferSlots(def.inputSlotCount),
    bufferOutput: createBufferSlots(def.outputSlotCount),
    inputPollIndex: 0, outputPollQueue: [],
    currentRecipeId: null, progress: 0, elapsed: 0,
  };
  world.addComponent(h, 'BuildingComp', comp);
  comp.bufferInput[0] = { itemId: 'originium_ore', count: 50 };
  comp.bufferOutput[0] = { itemId: 'origocrust', count: 5 };
  return comp;
})();
// A: 3 格 → 存货口（流动）; B: 2 格死端（先流动后饱和 → 触发 ⏳ 输出等待）
const mkBelt = (x: number, y: number, chainId: string, segIdx: number, isTail: boolean): void => {
  const h = world.createEntity();
  world.addComponent(h, 'Position', { x: x * CELL_SIZE, y: y * CELL_SIZE });
  world.addComponent(h, 'BeltSegmentComp', {
    chainId, direction: 270, isCorner: false, isTail,
    segmentIndex: segIdx, phaseOffset: 0, items: [], blocked: false,
  } as BeltSegmentComp);
};
for (let i = 0; i < 3; i++) mkBelt(5, 4 - i, 'chain-1755000000001-A', i, i === 2);
for (let i = 0; i < 2; i++) mkBelt(6, 4 - i, 'chain-1755000000002-B', i, i === 1);
{
  const def = BUILDING_DEFINITIONS['depot_loader' as keyof typeof BUILDING_DEFINITIONS];
  const h = world.createEntity();
  world.addComponent(h, 'Position', { x: 4 * CELL_SIZE, y: 1 * CELL_SIZE });
  world.addComponent(h, 'BuildingComp', {
    definitionId: 'depot_loader', direction: 180, state: 'idle', paused: false,
    bufferInput: createBufferSlots(def.inputSlotCount),
    bufferOutput: createBufferSlots(def.outputSlotCount),
    inputPollIndex: 0, outputPollQueue: [],
    currentRecipeId: null, progress: 0, elapsed: 0,
  } as BuildingComp);
}

logisticsDebug.enable(true);
for (let t = 0; t < 260; t++) {
  beltSys.update(world, 50);
  machineSys.update(world, 50);
}
console.log('─── 最近 45 条 ───');
console.log(logisticsDebug.dump(45));
