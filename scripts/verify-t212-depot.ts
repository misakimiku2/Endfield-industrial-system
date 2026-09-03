// T2.12 验证: 简化版仓库取货口/仓库存货口（无限源/汇、非生产设备、端口对接）
// 依据: implementation-phase-2.md T2.12（2026-08-24 用户澄清版）、A9 §6.7(端口连接判定)、
//       一格一物品规则、T2.6 预约制吸入、T2.7 相位窗口注入
//
// 用法: node --experimental-strip-types scripts/verify-t212-depot.ts
//
// 断言:
//   A 定义与端口几何:
//     1. depot_unloader/depot_loader 定义存在，3×1 占地，logistics 分类，无缓冲槽位
//     2. 取货口唯一输出口=中间格（T2.18）；180° 原地镜像
//     3. 存货口唯一输入口=中间格（T2.18；T2.19 接带面朝上，与取货口一致）
//   B DepotOps 纯逻辑:
//     4. DEPOT_SOURCE_ITEM = originium_ore（简化版固定源矿）
//     5. emitSourceToBelt: 相位窗口外 null / 段占用 null / 空段注入 beltPhase 相位
//     6. tryAbsorbHeadItemSink: 空段 null / 未到 0.5 null / 到门口无条件接受（无类型过滤）
//   C MachineSystem 集成（真实 World，belt→machine 每 Tick）:
//     7. 取货口 + 上升带链 → 带上出现源矿且全部 originium_ore
//     8. 无限源: 持续运行输出事件递增（永不枯竭）
//     9. 一格一物品不变量: 每段 ≤ 1 件
//    10. paused 取货口停止输出
//    11. 存货口吸入: 物品预约后走到 1.5 消失（走进设备半格深处）
//    12. 存货口无限汇: 逐件注入全部消失，bufferInput 恒为 []（无槽位）
//    13. 全链路: 取货口 → 4 段带 → 存货口，输出/接收事件持续产生
//    14. 非生产设备: state 恒 idle、currentRecipeId 恒 null
//   D 朝向策略（T2.17 四向旋转）:
//    15. R 一律 90° 四档循环；90°/270° 端口旋入互换后的 1×3 占地、outward 随朝向旋转
import { readFileSync } from 'node:fs';
import { World } from '../src/game/ECS.ts';
import type { EntityHandle } from '../src/game/ECS.ts';
import {
  parseItemCsv,
  productItemsFromRecipeCsv,
  EXTRA_ITEM_DEFS,
  buildItemRegistry,
} from '../src/game/data/items.ts';
import { parseRecipeCsv, buildRecipeIndex } from '../src/game/data/recipes.ts';
import { BUILDING_DEFINITIONS, createOutputPollQueue } from '../src/game/data/buildings.ts';
import { createBufferSlots } from '../src/game/systems/machine/BufferOps.ts';
import { buildBeltCellIndex, inputPortCells } from '../src/game/systems/machine/IntakeOps.ts';
import { outputPortCells } from '../src/game/systems/machine/OutputOps.ts';
import {
  DEPOT_SOURCE_ITEM,
  emitSourceToBelt,
  tryAbsorbHeadItemSink,
} from '../src/game/systems/machine/DepotOps.ts';
import { nextScreenAngle } from '../src/game/systems/RotationPolicy.ts';
import { BeltSystem } from '../src/game/systems/BeltSystem.ts';
import { MachineSystem } from '../src/game/systems/MachineSystem.ts';
import type { BuildingComp } from '../src/game/components/BuildingComp.ts';
import type { BeltSegmentComp } from '../src/game/components/BeltSegmentComp.ts';
import { CELL_SIZE } from '../src/game/render/constants.ts';

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
const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) < eps;

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

// ═══════════════════ A. 定义与端口几何 ═══════════════════
console.log('[定义与端口]');
const UNLOADER = BUILDING_DEFINITIONS.depot_unloader;
const LOADER = BUILDING_DEFINITIONS.depot_loader;
assert(UNLOADER !== undefined, '1a. depot_unloader 定义存在');
assert(LOADER !== undefined, '1b. depot_loader 定义存在');
if (UNLOADER && LOADER) {
  assertEq(UNLOADER.footprint, { w: 3, h: 1 }, '1c. 取货口占地 3×1');
  assertEq(LOADER.footprint, { w: 3, h: 1 }, '1d. 存货口占地 3×1');
  assert(UNLOADER.category === 'logistics' && LOADER.category === 'logistics', '1e. 双方 logistics 分类（非生产设备）');
  assertEq(UNLOADER.inputSlotCount + UNLOADER.outputSlotCount
    + LOADER.inputSlotCount + LOADER.outputSlotCount, 0, '1f. 四类槽位数全为 0（无缓冲区）');
  assertEq(UNLOADER.texture, 'depot', '1g. 取货口整图背景 texture=depot（共用 Depot.svg）');
  assertEq(LOADER.texture, 'depot', '1h. 存货口整图背景 texture=depot（共用 Depot.svg）');
  assertEq(UNLOADER.logoTextureKey, 'depot_unloader_logo', '1i. 取货口单层 LOGO key');
  assertEq(LOADER.logoTextureKey, 'depot_loader_logo', '1j. 存货口单层 LOGO key');

  console.log('[端口几何]');
  // T2.18: 只有中间格是端口（dx=1），两侧格不能起带/对接
  assertEq(outputPortCells(5, 5, UNLOADER, 0).map((c) => [c.x, c.y]), [[6, 5]],
    '2a. 取货口 0°: 唯一输出口=中间格 (6,5)');
  assertEq(outputPortCells(5, 5, UNLOADER, 180).map((c) => [c.x, c.y]), [[6, 5]],
    '2b. 取货口 180°: 中间格原地镜像（h=1 行内不变）');
  assertEq(outputPortCells(5, 5, UNLOADER, 0).length
    + inputPortCells(5, 5, UNLOADER, 0).length, 1, '2c. 取货口恰 1 个端口（输出）');
  assertEq(inputPortCells(5, 5, LOADER, 0).map((c) => [c.x, c.y]), [[6, 5]],
    '2d. 存货口 0°: 唯一输入口=中间格 (6,5)（T2.19: 接带面朝上，供给带在上方指入）');
  assertEq(outputPortCells(5, 5, LOADER, 0).length, 0, '2e. 存货口无输出口');
}

// ═══════════════════ B. DepotOps 纯逻辑 ═══════════════════
console.log('[DepotOps 纯逻辑]');
assertEq(DEPOT_SOURCE_ITEM, 'originium_ore', '4a. 简化版源物品 = 源矿 originium_ore');
{
  const mk = (items: Array<[string, number, boolean?]>): BeltSegmentComp => ({
    chainId: 'c', direction: 270, isCorner: false, isTail: true,
    segmentIndex: 0, phaseOffset: 0,
    items: items.map(([itemId, progress, entering]) => ({ itemId, progress, delta: 0, entering })),
  });
  BeltSystem.beltPhase = 0.7; // 旧版窗口外相位——2026-08-25 窗口退役，注入不再受相位限制
  const s5 = mk([]);
  assertEq(emitSourceToBelt(s5, 'originium_ore'), 'originium_ore',
    '5a. 空段 → 放出源矿（beltPhase=0.7 也可注入: 相位窗口退役，2026-08-25 解绑）');
  assertEq(s5.items, [{ itemId: 'originium_ore', progress: 0, delta: 0 }],
    '5a2. 注入段首 progress=0（2026-08-25 退役"物品=实体 pointer"，进度独立推进）');
  assertEq(emitSourceToBelt(mk([['originium_ore', 0.5]]), 'originium_ore'), null,
    '5b. 段上已有物品 → null（一格一物品，只往空段注入）');
  assertEq(emitSourceToBelt(s5, 'originium_ore'), null, '5c. 同段再放 → null（已占用）');

  assertEq(tryAbsorbHeadItemSink(mk([])), null, '6a. 空段 → null');
  assertEq(tryAbsorbHeadItemSink(mk([['origocrust', 0.3]])), null, '6b. 队首 0.3 未到门口 → null');
  const s6 = mk([['origocrust', 0.5]]);
  assertEq(tryAbsorbHeadItemSink(s6), 'origocrust',
    '6c. 队首 0.5 → 无条件接受（origocrust 非源矿也收——无限汇无类型过滤）');
  assertEq(s6.items[0].entering, true, '6c2. 接受即 entering（预约制，BeltSystem 放行至 1.5）');
  assertEq(tryAbsorbHeadItemSink(s6), null, '6d. entering 物品不重复预约（队首已属设备）');
}

// ═══════════════════ C. MachineSystem 集成 ═══════════════════
const DT = 50;
function freshWorld(): {
  world: World; beltSys: BeltSystem; machineSys: MachineSystem;
  place: (id: string, gx: number, gy: number, dir?: 0 | 90 | 180 | 270) => BuildingComp;
  belt: (gx: number, gy: number, direction: 0 | 90 | 180 | 270) => BeltSegmentComp;
  tick: (n?: number) => void;
} {
  const world = new World();
  const beltSys = new BeltSystem();
  const machineSys = new MachineSystem(recipeIndex, registry);
  const place = (id: string, gx: number, gy: number, dir: 0 | 90 | 180 | 270 = 0): BuildingComp => {
    const def = BUILDING_DEFINITIONS[id];
    const handle = world.createEntity();
    world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    const comp: BuildingComp = {
      definitionId: id, direction: dir, state: 'idle', paused: false,
      bufferInput: createBufferSlots(def.inputSlotCount),
      bufferOutput: createBufferSlots(def.outputSlotCount),
      inputPollIndex: 0, outputPollQueue: createOutputPollQueue(def), // T2.10
      currentRecipeId: null, progress: 0, elapsed: 0,
    };
    world.addComponent(handle, 'BuildingComp', comp);
    return comp;
  };
  const belt = (gx: number, gy: number, direction: 0 | 90 | 180 | 270): BeltSegmentComp => {
    const handle = world.createEntity();
    world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    const s: BeltSegmentComp = {
      chainId: `c-${gx}-${gy}`, direction, isCorner: false, isTail: true,
      segmentIndex: 0, phaseOffset: 0, items: [],
    };
    world.addComponent(handle, 'BeltSegmentComp', s);
    return s;
  };
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      beltSys.update(world, DT);
      machineSys.update(world, DT);
    }
  };
  return { world, beltSys, machineSys, place, belt, tick };
}
const depotEventCount = (machineSys: MachineSystem, type: string): number =>
  machineSys.recentEvents.filter((e) => e.type === type).length;

console.log('[取货口输出集成]');
{
  BeltSystem.beltPhase = 0;
  const { place, belt, tick, machineSys } = freshWorld();
  const u = place('depot_unloader', 5, 5);
  // 取货口 (5,5)-(7,5)，中输出口 (6,5)，接收带链 (6,4)→(6,0) 朝上 ×5
  const chain = [belt(6, 4, 270), belt(6, 3, 270), belt(6, 2, 270), belt(6, 1, 270), belt(6, 0, 270)];
  tick(120); // 6 秒
  const items = chain.flatMap((s) => s.items);
  assert(items.length > 0, '7a. 带上出现物品（取货口开始输出）');
  assert(items.every((it) => it.itemId === 'originium_ore'), '7b. 全部为源矿 originium_ore');
  assert(chain.every((s) => s.items.length <= 1), '9a. 每段 ≤ 1 件（一格一物品不变量）');
  const outN = depotEventCount(machineSys, 'depot-output');
  assert(outN >= 2, `8a. 无限源: 6 秒内输出事件 ≥ 2（实际 ${outN}，空带 1 件/2 秒/口）`);
  tick(120); // 再 6 秒
  assert(depotEventCount(machineSys, 'depot-output') > outN,
    '8b. 持续运行输出事件继续递增（源永不枯竭，无内部库存概念）');
  assertEq(u.state, 'idle', '14a. 取货口 state 恒 idle（非生产设备无状态机迁移）');
  assertEq(u.currentRecipeId, null, '14b. currentRecipeId 恒 null');

  // paused: 停止输出（带入物品继续流动，但不再有新注入）
  u.paused = true;
  const before = depotEventCount(machineSys, 'depot-output');
  tick(120);
  assertEq(depotEventCount(machineSys, 'depot-output'), before, '10a. paused 取货口不再输出');
}

console.log('[存货口吸入集成]');
{
  BeltSystem.beltPhase = 0;
  const { world, place, belt, tick, machineSys } = freshWorld();
  const l = place('depot_loader', 5, 10, 180); // (5,10)-(7,10)，中输入口 (6,10)，180°=接带面朝下，供给带 (6,11) 朝上指入
  const feeder = belt(6, 11, 270);
  // 注入一件 → 预约(0.5) → 放行(1.5) → 从段上消失
  feeder.items.push({ itemId: 'origocrust', progress: 0, delta: 0 });
  tick(120);
  assertEq(feeder.items.length, 0, '11a. 物品走进设备半格深处后消失（预约制两阶段）');
  assert(depotEventCount(machineSys, 'depot-input') >= 1, '11b. 产生 depot-input 接收事件');

  // 无限汇: 逐件注入 5 件（间隔等待相位推进，模拟带速到达），全部消失
  let absorbedTotal = 0;
  for (let i = 0; i < 5; i++) {
    // 等待相位窗口回到注入区（40 tick 一循环），注入一件，跑到消失
    tick(45);
    feeder.items.push({ itemId: i % 2 === 0 ? 'originium_ore' : 'origocrust', progress: 0, delta: 0 });
    tick(90);
    absorbedTotal += feeder.items.length === 0 ? 1 : 0;
  }
  assertEq(absorbedTotal, 5, '12a. 5 件（源矿/晶体外壳混合）全部被接收消失（无类型过滤）');
  assertEq(l.bufferInput.length, 0, '12b. bufferInput 恒 []（无槽位——T2.9 读数不显示数据的根因）');
  assertEq(l.state, 'idle', '14c. 存货口 state 恒 idle');
  assertEq(depotEventCount(machineSys, 'depot-input') >= 6, true, '12c. 接收事件累计 ≥ 6（永不堵塞）');
  void world;
}

console.log('[全链路: 取货口 → 4 段带 → 存货口]');
{
  BeltSystem.beltPhase = 0;
  const { place, belt, tick, machineSys } = freshWorld();
  place('depot_unloader', 5, 5);       // 中输出口 (6,5)
  place('depot_loader', 5, 0, 180);    // (5,0)-(7,0)，中输入口 (6,0)，180°=接带面朝下，供给带 (6,1)
  const chain = [belt(6, 4, 270), belt(6, 3, 270), belt(6, 2, 270), belt(6, 1, 270)];
  tick(600); // 30 秒
  const outN = depotEventCount(machineSys, 'depot-output');
  const inN = depotEventCount(machineSys, 'depot-input');
  // 2026-09-02 entering 不占格修订后，饱和门节拍 ≈2 秒/件（传送带本速，行走重叠；
  // 旧 4 秒/件 = 吸入行走 2s 占格 + 中心出发跨段 1s
  // + 到门口中心 1s；旧版爬到段尾边界候场是 3 秒/件——用户实测指出边界停车不符规范）
  assert(outN >= 8, `13a. 取货口持续输出 ≥ 8 件（实际 ${outN}）`);
  assert(inN >= 5, `13b. 存货口持续接收 ≥ 5 件（实际 ${inN}，链上最多滞留 4 件）`);
  assert(chain.every((s) => s.items.length <= 1), '13c. 一格一物品不变量');
  const onBelt = chain.reduce((n, s) => n + s.items.length, 0);
  assert(onBelt <= 4, `13d. 带上流动滞留 ≤ 4 件（实际 ${onBelt}，其余已进入存货口消失）`);
}

// ═══════════════════ D. 朝向策略（T2.17: 四档旋转 + 占地宽高互换）═══════════════════
console.log('[朝向策略]');
assertEq(nextScreenAngle(0), 90, '15a. 按 R: 0° → 90°（T2.17 四档全开放）');
assertEq(nextScreenAngle(90), 180, '15b. 按 R: 90° → 180°');
assertEq(nextScreenAngle(180), 270, '15c. 按 R: 180° → 270°');
assertEq(nextScreenAngle(270), 0, '15d. 按 R: 270° → 0°（循环）');
const u90 = outputPortCells(5, 5, UNLOADER, 90);
assertEq(u90.map((c) => [c.x, c.y]), [[5, 6]],
  '15e. 取货口 90°: 唯一输出口=竖放 1×3 占地的中间格 (5,6)');
assert(u90.every((c) => c.outward === 0), '15f. 取货口 90°: 功能面朝右——带从右侧接出');
const u270 = outputPortCells(5, 5, UNLOADER, 270);
assertEq(u270.map((c) => [c.x, c.y]), [[5, 6]],
  '15g. 取货口 270°: 唯一输出口=中间格 (5,6)');
assert(u270.every((c) => c.outward === 180), '15h. 取货口 270°: 功能面朝左——带从左侧接出');
const l90 = inputPortCells(5, 5, LOADER, 90);
assertEq(l90.map((c) => [c.x, c.y]), [[5, 6]],
  '15i. 存货口 90°: 唯一输入口=中间格 (5,6)');
assert(l90.every((c) => c.outward === 0), '15j. 存货口 90°: 功能面朝右——供给带从右侧指入（T2.19 输入口与输出口同向）');

// ── 汇总 ──
console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.error('❌ T2.12 验证失败');
  process.exit(1);
}
console.log('✅ T2.12 全部断言通过');
