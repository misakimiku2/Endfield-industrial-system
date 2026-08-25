// T2.8 验证: 设备状态机与终末地风格状态视觉（paused 状态 + LOGO 视觉解析 + 端口高亮判定）
// 依据: implementation-phase-2.md T2.8、A8 §6(状态机)/§2.2(结算暂缓)、
//       A9 §6.7(端口连接判定)、T2.6 满槽堵停 / T2.7 满带留槽
//
// 用法: node --experimental-strip-types scripts/verify-t28-state-visual.ts
//
// 断言:
//   纯逻辑:
//     1. resolveLogoState: normal/paused/blocked + paused 与 blocked 同时成立优先暂停
//   PortStatusOps 端口状态判定:
//     2. 输入端口: 有供给带=connected；物品停门口(0.5 非 entering)=blocked；
//        entering 物品不算堵；paused 时门口停车不算堵
//     3. 输出端口: 入口朝向端口的带=connected；输出槽有货+带被占=blocked；
//        输出槽空 → 不红
//     4. 未连接端口不显示高亮；旋转设备(90°)端口格与实际端口对齐
//   paused 状态机（真实 World，belt→machine 每 Tick）:
//     5. 暂停时计时冻结（elapsed/progress 不变），恢复后从暂停处继续（elapsed 保留增长）
//     6. 暂停时不预约吸入（门口物品停 0.5、槽不加）；恢复后立即预约
//     7. 暂停时已预约(entering)物品照常放行（到 1.5 移除，不卡设备深处）
//     8. 暂停时不输出（输出槽有货 + 空接收带 → 带保持空）；恢复后出货
//     9. 暂停期间 state 保持（working 冻结不回 idle/blocked）
import { readFileSync } from 'node:fs';
import { World } from '../src/game/ECS.ts';
import {
  parseItemCsv,
  productItemsFromRecipeCsv,
  EXTRA_ITEM_DEFS,
  buildItemRegistry,
} from '../src/game/data/items.ts';
import { parseRecipeCsv, buildRecipeIndex } from '../src/game/data/recipes.ts';
import { BUILDING_DEFINITIONS } from '../src/game/data/buildings.ts';
import { createBufferSlots } from '../src/game/systems/machine/BufferOps.ts';
import {
  resolveLogoState,
  type BuildingComp,
} from '../src/game/components/BuildingComp.ts';
import type { BeltSegmentComp } from '../src/game/components/BeltSegmentComp.ts';
import {
  inputPortStatuses,
  outputPortStatuses,
} from '../src/game/systems/machine/PortStatusOps.ts';
import { buildBeltCellIndex } from '../src/game/systems/machine/IntakeOps.ts';
import { BeltSystem } from '../src/game/systems/BeltSystem.ts';
import { MachineSystem } from '../src/game/systems/MachineSystem.ts';
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
const FURNACE = BUILDING_DEFINITIONS.refining_unit;

// ═══════════════════ 1. resolveLogoState 纯逻辑 ═══════════════════
console.log('[resolveLogoState LOGO 视觉解析]');
assertEq(resolveLogoState(false, 'idle'), 'normal', '1a. 未暂停+idle → normal（原 LOGO）');
assertEq(resolveLogoState(false, 'working'), 'normal', '1b. 未暂停+working → normal（正常生产不改外观）');
assertEq(resolveLogoState(false, 'blocked'), 'blocked', '1c. 未暂停+blocked → blocked（红 X）');
assertEq(resolveLogoState(true, 'idle'), 'paused', '1d. 暂停+idle → paused（深灰暂停图标）');
assertEq(resolveLogoState(true, 'working'), 'paused', '1e. 暂停+working → paused');
assertEq(resolveLogoState(true, 'blocked'), 'paused',
  '1f. 暂停与堵塞同时成立 → 优先暂停（玩家主动操作意图优先，T2.8 需求1）');

// ═══════════════════ 2-4. PortStatusOps 端口状态判定 ═══════════════════
console.log('[PortStatusOps 端口连接/堵塞判定]');
{
  const w = new World();
  const mkComp = (dir: 0 | 90 | 180 | 270 = 0): BuildingComp => ({
    definitionId: 'refining_unit', direction: dir, state: 'idle', paused: false,
    bufferInput: createBufferSlots(1), bufferOutput: createBufferSlots(1),
    inputPollIndex: 0, outputPollQueue: [0, 1, 2], // T2.10（PortStatusOps 不读轮询状态，占位补形）
    currentRecipeId: null, progress: 0, elapsed: 0,
  });
  const addBelt = (
    gx: number, gy: number, d: 0 | 90 | 180 | 270,
    items: Array<[string, number, boolean?]> = [],
    blocked = false,
  ): BeltSegmentComp => {
    const h = w.createEntity();
    w.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    const s: BeltSegmentComp = {
      chainId: `c-${gx}-${gy}`, direction: d, isCorner: false, isTail: true,
      segmentIndex: 0, phaseOffset: 0, blocked,
      items: items.map(([itemId, progress, entering]) => ({ itemId, progress, delta: 0, entering })),
    };
    w.addComponent(h, 'BeltSegmentComp', s);
    return s;
  };
  const mkBuilding = (gx: number, gy: number, comp: BuildingComp): { h: number; comp: BuildingComp } => {
    const h = w.createEntity();
    w.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    w.addComponent(h, 'BuildingComp', comp);
    return { h, comp };
  };

  // 2: 输入端口判定 —— 炉(5,5) 底排端口 (5,7)(6,7)(7,7)，中口 (6,7) 供给带 (6,8) 朝上
  const fA = mkComp();
  const { h: hA } = mkBuilding(5, 5, fA);
  addBelt(6, 8, 270); // 供给带（空）
  const idxA = buildBeltCellIndex(w);
  const inA = inputPortStatuses(w, idxA, hA, fA, FURNACE);
  assertEq(inA.map((p) => [p.x, p.y, p.connected]), [
    [5, 7, false], [6, 7, true], [7, 7, false],
  ], '2a. 输入端口: 仅中口 (6,7) 有供给带 connected（左/右未连接）');

  // 2b: 物品停门口 → blocked 红
  const fB = mkComp();
  const { h: hB } = mkBuilding(10, 5, fB); // 端口 (11,7)
  addBelt(11, 8, 270, [['originium_ore', 0.5]], true); // 队首停稳 → BeltSystem 整链 blocked
  const idxB = buildBeltCellIndex(w);
  const inB = inputPortStatuses(w, idxB, hB, fB, FURNACE);
  assert(inB.every((p) => !p.blocked || p.connected), '2b0. (前置) blocked 蕴含 connected');
  assertEq(inB.find((p) => p.x === 11)?.blocked, true,
    '2b. 门口物品(0.5 非 entering) → 输入端口 blocked（红，满槽堵停语义）');

  // 2c: entering 物品不算堵
  const fC = mkComp();
  const { h: hC } = mkBuilding(15, 5, fC); // 端口 (16,7)
  addBelt(16, 8, 270, [['originium_ore', 0.9, true]]);
  const idxC = buildBeltCellIndex(w);
  assertEq(
    inputPortStatuses(w, idxC, hC, fC, FURNACE).find((p) => p.x === 16)?.blocked, false,
    '2c. entering 物品（已预约正走进设备）→ 不算堵');
  // 2d: 队首还在路上不算堵
  const fD = mkComp();
  const { h: hD } = mkBuilding(20, 5, fD); // 端口 (21,7)
  addBelt(21, 8, 270, [['originium_ore', 0.3]]);
  const idxD = buildBeltCellIndex(w);
  assertEq(
    inputPortStatuses(w, idxD, hD, fD, FURNACE).find((p) => p.x === 21)?.blocked, false,
    '2d. 物品还在路上(0.3) → 不算堵');
  // 2e: paused 时门口停车不算堵
  const fE = mkComp();
  fE.paused = true;
  const { h: hE } = mkBuilding(25, 5, fE); // 端口 (26,7)
  addBelt(26, 8, 270, [['originium_ore', 0.5]]);
  const idxE = buildBeltCellIndex(w);
  const inE = inputPortStatuses(w, idxE, hE, fE, FURNACE);
  assertEq(inE.find((p) => p.x === 26)?.connected, true, '2e0. (前置) paused 时连接仍成立（黄保留）');
  assertEq(inE.find((p) => p.x === 26)?.blocked, false,
    '2e. paused 时门口停车不算堵（暂停由 LOGO 指示，非真堵塞）');

  // 3: 输出端口判定 —— 炉(30,5) 顶排端口 (30,5)(31,5)(32,5)，中口 (31,5) 接收带 (31,4) 朝上(入口朝下)
  const fF = mkComp();
  const { h: hF } = mkBuilding(30, 5, fF);
  const outBelt = addBelt(31, 4, 270);
  const idxF = buildBeltCellIndex(w);
  const outF = outputPortStatuses(w, idxF, hF, fF, FURNACE);
  assertEq(outF.map((p) => [p.x, p.y, p.connected]), [
    [30, 5, false], [31, 5, true], [32, 5, false],
  ], '3a. 输出端口: 仅中口 (31,5) 有接收带 connected');
  assertEq(outF.find((p) => p.x === 31)?.blocked, false,
    '3b. 接收带空（未堵）→ 不算堵');
  // 3c: 输出槽有货但接收带空（seg.blocked=false）→ 不算堵（与输出槽是否有货无关）
  fF.bufferOutput[0] = { itemId: 'origocrust', count: 5 };
  assertEq(outputPortStatuses(w, idxF, hF, fF, FURNACE).find((p) => p.x === 31)?.blocked, false,
    '3c. 输出槽有货但接收带空 → 不算堵（带未堵）');
  // 3d: 接收带整链堵（seg.blocked）→ blocked 红（即使输出槽空也红，与传送带堵塞同步）
  outBelt.items.push({ itemId: 'origocrust', progress: 0.5, delta: 0 });
  outBelt.blocked = true; // 模拟 BeltSystem 整链堵塞（段首被占/下游堵）
  assertEq(outputPortStatuses(w, idxF, hF, fF, FURNACE).find((p) => p.x === 31)?.blocked, true,
    '3d. 接收带堵塞(seg.blocked) → blocked（红，与传送带整链堵塞同步，不看输出槽）');
  // 3e: paused 时输出不红（视同离线）
  fF.paused = true;
  assertEq(outputPortStatuses(w, idxF, hF, fF, FURNACE).find((p) => p.x === 31)?.blocked, false,
    '3e. paused 时输出满带不算堵（视同离线）');
  fF.paused = false;

  // 4: 旋转设备(90°) 端口格与实际端口对齐 —— 炉(35,10) 90°: 输入左列 (35,10..12)，输出右列 (37,10..12)
  const fG = mkComp(90);
  const { h: hG } = mkBuilding(35, 10, fG);
  addBelt(34, 11, 0); // (34,11) 朝右 → 指向输入口 (35,11)
  addBelt(38, 11, 0); // (38,11) 朝右（从端口侧进料、流向背离设备）→ 接收输出口 (37,11) 的货
  const idxG = buildBeltCellIndex(w);
  const inG = inputPortStatuses(w, idxG, hG, fG, FURNACE);
  const outG = outputPortStatuses(w, idxG, hG, fG, FURNACE);
  assertEq(inG.map((p) => [p.x, p.y, p.connected]), [
    [35, 10, false], [35, 11, true], [35, 12, false],
  ], '4a. 90° 设备输入端口转到左列，中口 (35,11) 连接（rotatePort 对齐）');
  assertEq(outG.map((p) => [p.x, p.y, p.connected]), [
    [37, 10, false], [37, 11, true], [37, 12, false],
  ], '4b. 90° 设备输出端口转到右列，中口 (37,11) 连接（高亮位置=实际端口）');
}

// ═══════════════════ 5-9. paused 状态机集成（真实 World）═══════════════════
console.log('[paused 状态机集成（真实 World，belt→machine 每 Tick）]');
const DT = 50;
const world = new World();
const beltSys = new BeltSystem();
const machineSys = new MachineSystem(recipeIndex, registry);

const place = (gx: number, gy: number, dir: 0 | 90 | 180 | 270 = 0): { h: number; comp: BuildingComp } => {
  const handle = world.createEntity();
  world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
  const comp: BuildingComp = {
    definitionId: 'refining_unit', direction: dir, state: 'idle', paused: false,
    bufferInput: createBufferSlots(1), bufferOutput: createBufferSlots(1),
    inputPollIndex: 0, outputPollQueue: [0, 1, 2], // T2.10
    currentRecipeId: null, progress: 0, elapsed: 0,
  };
  world.addComponent(handle, 'BuildingComp', comp);
  return { h: handle, comp };
};
const belt = (
  gx: number, gy: number, direction: 0 | 90 | 180 | 270,
  items: Array<[string, number]> = [],
): BeltSegmentComp => {
  const handle = world.createEntity();
  world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
  const s: BeltSegmentComp = {
    chainId: `c-${gx}-${gy}`, direction, isCorner: false, isTail: true,
    segmentIndex: 0, phaseOffset: 0,
    items: items.map(([itemId, progress]) => ({ itemId, progress, delta: 0 })),
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

// 5: 暂停时计时冻结 + 恢复从暂停处继续
{
  const { comp } = place(40, 5);
  comp.bufferInput[0] = { itemId: 'originium_ore', count: 10 };
  tick(1); // 启动计时
  assert(comp.state === 'working' && comp.currentRecipeId !== null, '5a. 注源矿后启动计时（working）');
  tick(10); // 推进 500ms
  const before = { elapsed: comp.elapsed, progress: comp.progress, recipeId: comp.currentRecipeId };
  assertEq(before.elapsed, 500, '5b. (前置) 10 Tick 后 elapsed=500ms');
  comp.paused = true;
  tick(20); // 暂停 20 Tick
  assertEq(comp.elapsed, before.elapsed, '5c. 暂停期间 elapsed 冻结（不推进）');
  assertEq(comp.progress, before.progress, '5d. 暂停期间 progress 冻结');
  assertEq(comp.state, 'working', '5e. 暂停期间 state 保持 working（暂停不回 idle）');
  assertEq(comp.currentRecipeId, before.recipeId,
    '5f. 暂停期间配方计时保留（currentRecipeId 不清）');
  comp.paused = false;
  tick(2); // 恢复推进 100ms
  assertEq(comp.elapsed, before.elapsed + 100, '5g. 恢复后从暂停处继续（elapsed=600，进度不归零）');
}

// 6: 暂停时不预约吸入；恢复后立即预约
{
  const { comp } = place(45, 5); // 端口 (46,7)
  comp.bufferOutput[0] = { itemId: 'origocrust', count: 50 }; // blocked 隔离: 结算暂缓不消耗输入
  const b = belt(46, 8, 270, [['originium_ore', 0]]);
  comp.paused = true;
  tick(30); // 暂停中物品走到门口 + 停留
  assert(b.items.length === 1 && near(b.items[0].progress, 0.5),
    `6a. 暂停中物品停在门口 0.5（实际 ${b.items[0]?.progress.toFixed(3)}，不预约）`);
  assertEq(comp.bufferInput[0].count, 0, '6b. 暂停中输入槽不加（物流视同离线）');
  comp.paused = false;
  tick(2); // 恢复: 第 1 Tick 预约（槽+1、entering），第 2 Tick 走进设备
  assertEq(comp.bufferInput[0], { itemId: 'originium_ore', count: 1 },
    '6c. 恢复后门口物品立即被预约（槽 +1）');
  assert(b.items[0]?.entering === true && b.items[0].progress > 0.5,
    '6d. 恢复后物品走进设备（entering=true）');
}

// 7: 暂停时已预约(entering)物品照常放行
{
  const { comp } = place(50, 5); // 端口 (51,7)
  comp.bufferOutput[0] = { itemId: 'origocrust', count: 50 };
  const b = belt(51, 8, 270, [['originium_ore', 0]]);
  tick(21); // 走到门口 + 预约（entering）
  const okReserve = b.items[0]?.entering === true && (comp.bufferInput[0].count ?? 0) === 1;
  assert(okReserve, '7a. (前置) 暂停前物品已在门口预约（entering=true, 槽+1）');
  comp.paused = true;
  tick(45); // 暂停中: entering 物品被 BeltSystem 放行推进到 1.5 → releaseEnteringItems 移除
  assertEq(b.items.length, 0,
    '7b. 暂停中已预约物品照常放行（到端口格中心移除，不卡设备深处）');
  assertEq(comp.bufferInput[0].count, 1, '7c. 已占用的槽位保留（预约不回退）');
}

// 8: 暂停时不输出；恢复后出货
{
  const { comp } = place(55, 5); // 输出中口 (56,5)，接收带 (56,4)
  const b = belt(56, 4, 270);
  comp.bufferOutput[0] = { itemId: 'origocrust', count: 5 };
  comp.paused = true;
  tick(80); // 暂停 80 Tick（4 秒 > 注入窗口周期）
  assertEq(b.items.length, 0, '8a. 暂停中输出槽有货 + 空接收带 → 带保持空（不输出）');
  assertEq(comp.bufferOutput[0].count, 5, '8b. 暂停中输出槽数量不变');
  comp.paused = false;
  // 恢复后出货: beltPhase ≤ 0.5 窗口每秒一次，80 Tick 内必命中
  let emitted = false;
  for (let i = 0; i < 80 && !emitted; i++) {
    tick(1);
    emitted = b.items.length > 0;
  }
  assert(emitted, '8c. 恢复后物品上带（输出物流恢复）');
  assertEq(comp.bufferOutput[0].count, 4, '8d. 输出槽扣减 1');
}

// 9: 暂停 + blocked 同时成立的集成形态（resolveLogoState 已覆盖优先级，此处验证状态共存）
{
  const { comp } = place(60, 5);
  comp.bufferInput[0] = { itemId: 'originium_ore', count: 5 };
  comp.bufferOutput[0] = { itemId: 'origocrust', count: 50 }; // 注满输出
  tick(45); // 40 Tick 计时完成 → 结算暂缓 → blocked
  assertEq(comp.state, 'blocked', '9a. (前置) 输出满 → blocked');
  comp.paused = true;
  tick(5);
  assertEq(comp.state, 'blocked', '9b. paused 期间 blocked 状态保留（两标志独立共存）');
  assertEq(resolveLogoState(comp.paused, comp.state), 'paused',
    '9c. 集成形态: paused+blocked → LOGO 显示暂停图标（优先级正确）');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
