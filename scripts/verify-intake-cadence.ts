// 2026-09-02 修复验证: entering 过客不占供给格 → 单带本速 2s/件、三带 3× 吞吐
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
import type { BuildingComp } from '../src/game/components/BuildingComp.ts';
import type { BeltSegmentComp } from '../src/game/components/BeltSegmentComp.ts';
import { CELL_SIZE } from '../src/game/render/constants.ts';

const RESOURCE_CSV = readFileSync('doc/csv/终末地资源列表 - 自然资源.csv', 'utf-8');
const RECIPE_CSV = readFileSync('doc/csv/recipe.csv', 'utf-8');
const registry = buildItemRegistry([
  ...parseItemCsv(RESOURCE_CSV), ...productItemsFromRecipeCsv(RECIPE_CSV), ...EXTRA_ITEM_DEFS,
]);
const nameToId = new Map<string, string>();
for (const def of Object.values(BUILDING_DEFINITIONS)) nameToId.set(def.name, def.id);
const recipeIndex = buildRecipeIndex(parseRecipeCsv(RECIPE_CSV, registry, nameToId).recipes);

function makeWorld() {
  const world = new World();
  const belt = new BeltSystem();
  const machine = new MachineSystem(recipeIndex, registry);
  let tick = 0;
  const events: Array<{ tick: number; port: number }> = [];
  machine.onEvent = (e) => { if (e.type === 'input') events.push({ tick, port: e.portIndex ?? -1 }); };
  const place = (defId: string, gx: number, gy: number) => {
    const def = BUILDING_DEFINITIONS[defId as keyof typeof BUILDING_DEFINITIONS];
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    world.addComponent(h, 'BuildingComp', {
      definitionId: defId, direction: 0, state: 'idle',
      bufferInput: createBufferSlots(def.inputSlotCount),
      bufferOutput: createBufferSlots(def.outputSlotCount),
      inputPollIndex: 0, outputPollQueue: [],
      currentRecipeId: null, progress: 0, elapsed: 0, paused: false,
    } as unknown as BuildingComp);
    return world.getComponent<BuildingComp>(h, 'BuildingComp')!;
  };
  const beltAt = (gx: number, gy: number, dir: 0|90|180|270, chain: string) => {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    world.addComponent(h, 'BeltSegmentComp', {
      chainId: chain, direction: dir, isCorner: false, isTail: true,
      segmentIndex: 0, phaseOffset: 0, items: [],
    } as BeltSegmentComp);
  };
  return {
    world, place, beltAt,
    step: () => { tick++; belt.update(world, 50); machine.update(world, 50); },
    events: () => events,
    furnaceComp: (c: BuildingComp) => c,
  };
}

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.error(`  ❌ ${m}`); } };

// ── A. 单带饱和节拍: 取货口 → 3 格带 → 精炼炉（输出槽预满防消耗干扰输入计数? 不——生产照常，看吸入节拍）
console.log('[A] 单带节拍（修复前 4.05s/件，期望 ≈2s/件）');
{
  const sc = makeWorld();
  const f = sc.place('refining_unit', 5, 5);
  sc.place('depot_unloader', 5, 11);
  for (const y of [10, 9, 8]) sc.beltAt(6, y, 270, 'c1');
  for (let i = 0; i < 800; i++) sc.step();
  const ev = sc.events().slice(1, 7); // 跳过首件（含装填），取稳态 6 件
  const gaps = ev.slice(1).map((e, i) => e.tick - ev[i].tick);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  console.log(`  稳态吸入 tick 间隔: [${gaps.join(',')}] 平均 ${avg.toFixed(1)} tick = ${(avg * 0.05).toFixed(2)}s/件`);
  ok(avg <= 42, `A1. 单带节拍 ≤ 2.1s/件（平均 ${(avg * 0.05).toFixed(2)}s）——传送带本速，walking 不再占格`);
}

// ── B. 三带吞吐: 同一取货口三口各接 3 格带 → 饱和期总吸入速率 ≈ 3× 单带
console.log('[B] 三带同时进料吞吐（期望 ≈ 3× 单带 = 1.5 件/s）');
{
  const sc = makeWorld();
  const f = sc.place('refining_unit', 5, 5);
  sc.place('depot_loader', 5, 1); // 排产物防 blocked
  for (const y of [4, 3, 2]) sc.beltAt(6, y, 270, 'drain');
  sc.place('depot_unloader', 5, 11);
  for (const x of [5, 6, 7]) for (const y of [10, 9, 8]) sc.beltAt(x, y, 270, `c${x}`);
  for (let i = 0; i < 1000; i++) sc.step(); // 50s
  const evts = sc.events();
  const total = evts.length;
  const rate = total / 50;
  console.log(`  50s 总吸入 ${total} 件（含装填期），平均 ${rate.toFixed(2)} 件/s`);
  ok(rate >= 1.0, `B1. 三带合计吞吐 ≥ 1.0 件/s（实际 ${rate.toFixed(2)}，修复前 ≈0.74 理论上限 1.5）`);
  // 槽位应当明显积累（供给 1.5/s - 消耗 0.5/s = 净 +1/s）
  ok(f.bufferInput[0].count >= 30, `B2. 50s 后输入槽 ≥30（实际 ${f.bufferInput[0].count}）——三带同供明显快于消耗`);
}

// ── C. 满槽堵塞语义不变: 槽满 → 物品停供给格中心 0.5、排队物品停自己格中心
console.log('[C] 满槽排队语义（不应被本次修复破坏）');
{
  const sc = makeWorld();
  const f = sc.place('refining_unit', 5, 5);
  sc.place('depot_unloader', 5, 11);
  for (const y of [10, 9, 8]) sc.beltAt(6, y, 270, 'c1');
  // 直接注入满槽 + 预置带上门物品；输出槽预满防结算腾位（隔离排队语义）
  f.bufferInput[0] = { itemId: 'originium_ore', count: 50 };
  f.bufferOutput[0] = { itemId: 'origocrust', count: 50 };
  // 找到门格 (6,8) 与上游格 (6,9) 段
  let door: BeltSegmentComp | null = null, upper: BeltSegmentComp | null = null;
  for (const h of sc.world.query('BeltSegmentComp', 'Position')) {
    const p = sc.world.getComponent<{ x: number; y: number }>(h, 'Position');
    const s = sc.world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp');
    if (Math.round(p.x / CELL_SIZE) === 6 && Math.round(p.y / CELL_SIZE) === 8) door = s;
    if (Math.round(p.x / CELL_SIZE) === 6 && Math.round(p.y / CELL_SIZE) === 9) upper = s;
  }
  door!.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  upper!.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  for (let i = 0; i < 60; i++) sc.step();
  ok(door!.items.some((it) => !it.entering && Math.abs(it.progress - 0.5) < 0.001),
    'C1. 槽满: 门格物品停在供给格中心 0.5 未被吸入');
  ok(upper!.items.some((it) => !it.entering && Math.abs(it.progress - 0.5) < 0.001),
    'C2. 槽满: 排队物品停自己格中心 0.5（2026-08-25 语义保持）');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
