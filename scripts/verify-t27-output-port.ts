// T2.7 验证: 设备 → 传送带输出对接（端口出货: 连接判定 + beltPhase 相位注入 + 满带留槽 + 疏通恢复）
// 依据: implementation-phase-2.md T2.7、A9 §6.7(端口连接判定)、A8 §2.2(输出槽一槽一物)/
//       §4.2(输出轮询·每端口每Tick至多1件)/§7 步骤3(输出物流)、
//       一格一物品规则（用户 2026-08-17 澄清，修订 A9 §2.3 间距）
//
// 用法: node --experimental-strip-types scripts/verify-t27-output-port.ts
//
// 断言:
//   OutputOps 纯逻辑:
//     1. outputPortCells 端口旋转: 精炼炉 0°→顶排 / 90°→右列 / 180°→底排 / 270°→左列
//     2. findReceiverBelt 连接判定: 入口朝向端口的段命中；平行经过/不相邻 → null；
//        转角段 entryDir 朝向端口 → 命中；转角入口背离 → null
//     3. tryEmitToBelt: 输出槽空 → null；beltPhase > STOP_MAX → null（注入窗口）；
//        空带 → 注入 beltPhase 相位 + 槽 count-1；扣到 0 解锁
//     4. tryEmitToBelt: 段上已有物品 → null（一格一物品，只往空段注入，物品留在输出槽）
//   BeltSystem + MachineSystem 集成（真实 World，DD-010 顺序 belt→machine）:
//     5. 产物上带: 5 段带 + 输出槽 5 件 → 逐件上带，**每段恰 1 件**停在格中心（一格一物品）
//     6. 流动过程不变量: 任意时刻每段 ≤ 1 件
//     7. 满带留槽: 1 格断头带 1 件@0.5 即满 → 其余 4 件留在输出槽（数量不变）
//     8. 疏通恢复: 取走带上 1 件 → 输出槽物品继续上带
//     9. 方向判定: 同格但方向平行经过（朝右）→ 永不接收，物品留在输出槽
//    11. 旋转设备: 90°/180°/270° 精炼炉的输出端口侧各有一条背离带 → 均出货
//    12. 每端口每 Tick 至多 1 件: 3 条接收带（3 输出端口）→ 同 Tick 各出 1 件（单输出槽 ×3）
//    13. 全链路: 精炼炉A 注矿 → 生产结算 → 产物上带 → 上升 → 精炼炉B 输入端口吸入（T2.5+T2.6+T2.7）
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
import { buildBeltCellIndex } from '../src/game/systems/machine/IntakeOps.ts';
import {
  outputPortCells,
  findReceiverBelt,
  tryEmitToBelt,
} from '../src/game/systems/machine/OutputOps.ts';
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
const FURNACE = BUILDING_DEFINITIONS.refining_unit;

// ═══════════════════ OutputOps 纯逻辑 ═══════════════════
console.log('[outputPortCells 端口旋转]');
assertEq(outputPortCells(5, 5, FURNACE, 0).map((c) => [c.x, c.y]), [[5, 5], [6, 5], [7, 5]],
  '1a. 0°（默认）: 输出端口在顶排 (5,5)(6,5)(7,5)');
assertEq(outputPortCells(5, 5, FURNACE, 90).map((c) => [c.x, c.y]), [[7, 5], [7, 6], [7, 7]],
  '1b. 90°: 输出端口转到右列 (7,5)(7,6)(7,7)');
assertEq(outputPortCells(5, 5, FURNACE, 180).map((c) => [c.x, c.y]), [[7, 7], [6, 7], [5, 7]],
  '1c. 180°: 输出端口转到 底排（定义序 左→中→右 旋转后物理位置反序）');
assertEq(outputPortCells(5, 5, FURNACE, 270).map((c) => [c.x, c.y]), [[5, 7], [5, 6], [5, 5]],
  '1d. 270°: 输出端口转到左列（同上，定义序旋转）');
assertEq(outputPortCells(5, 5, FURNACE, 0).length, 3, '1e. 只含 type=output（输入 3 + 液体 2 不在内）');

console.log('[findReceiverBelt 连接判定]');
{
  const w = new World();
  const handles: EntityHandle[] = [];
  const at = (
    gx: number, gy: number, d: 0 | 90 | 180 | 270,
    corner?: { entryDir: 0 | 90 | 180 | 270 },
  ): EntityHandle => {
    const h = w.createEntity();
    handles.push(h);
    w.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    w.addComponent(h, 'BeltSegmentComp', {
      chainId: 'c', direction: d, isCorner: corner !== undefined, isTail: true,
      entryDir: corner?.entryDir, segmentIndex: 0, phaseOffset: 0, items: [],
    });
    return h;
  };
  const straight = at(6, 4, 270);              // (6,4) 朝上 → 入口侧 (6,5) = 端口 ✓
  at(6, 3, 270);                               // 更远的朝上段（入口侧 (6,4)，与端口 (6,5) 无关）
  at(8, 6, 0);                                 // 远处朝右段 ✗
  const cornerHit = at(7, 4, 0, { entryDir: 270 }); // 转角: 从下方进入 (入口侧 (7,5)=右上端口)、出口朝右 ✓
  const idx = buildBeltCellIndex(w);
  assertEq(idx.size, 4, '2a. 格索引收录全部 4 段');
  assertEq(findReceiverBelt(w, idx, { x: 6, y: 5 }), straight,
    '2b. (6,4)朝上 → 是输出端口 (6,5) 的接收带（方向背离设备）');
  assertEq(findReceiverBelt(w, idx, { x: 7, y: 5 }), cornerHit,
    '2c. 转角段 (7,4)（entryDir=270 入口在下方端口、出口朝右）→ 是端口 (7,5) 的接收带');
  assertEq(findReceiverBelt(w, idx, { x: 5, y: 5 }), null,
    '2d. 端口 (5,5) 相邻格无入口朝向它的段 → null');
  assertEq(findReceiverBelt(w, idx, { x: 2, y: 2 }), null, '2e. 无相邻段的格 → null');
}
{
  // 转角入口背离: (6,4) 转角 entryDir=0（从左侧 (5,4) 进入）、出口朝上 → 入口侧不是端口 (6,5)
  const w = new World();
  const h = w.createEntity();
  w.addComponent(h, 'Position', { x: 6 * CELL_SIZE, y: 4 * CELL_SIZE });
  w.addComponent(h, 'BeltSegmentComp', {
    chainId: 'c', direction: 270, isCorner: true, isTail: true,
    entryDir: 0, segmentIndex: 0, phaseOffset: 0, items: [],
  });
  const idx = buildBeltCellIndex(w);
  assertEq(findReceiverBelt(w, idx, { x: 6, y: 5 }), null,
    '2f. 转角段入口背离端口（entryDir=0 入口在左侧）→ null（连接判定用 entryDir 而非 direction）');
}

console.log('[tryEmitToBelt 出货判定]');
{
  BeltSystem.beltPhase = 0.2; // 注入窗口内（≤ STOP_MAX）
  const comp: BuildingComp = {
    definitionId: 'refining_unit', direction: 0, state: 'idle',
    bufferInput: createBufferSlots(1), bufferOutput: createBufferSlots(1),
    inputPollIndex: 0, outputPollQueue: [0, 1, 2], // T2.10（tryEmitToBelt 不读轮询状态，占位补形）
    currentRecipeId: null, progress: 0, elapsed: 0,
  };
  const mk = (items: Array<[string, number]>): BeltSegmentComp => ({
    chainId: 'c', direction: 270, isCorner: false, isTail: true,
    segmentIndex: 0, phaseOffset: 0,
    items: items.map(([itemId, progress]) => ({ itemId, progress, delta: 0 })),
  });
  assertEq(tryEmitToBelt(mk([]), comp), null, '3a. 输出槽空 → null');
  comp.bufferOutput[0] = { itemId: 'origocrust', count: 2 };
  BeltSystem.beltPhase = 0.7; // > STOP_MAX 窗口外
  assertEq(tryEmitToBelt(mk([]), comp), null, '3b. beltPhase=0.7 > STOP_MAX → null（等 pointer 回到靠端口半格）');
  BeltSystem.beltPhase = 0.2;
  const s3 = mk([]);
  assertEq(tryEmitToBelt(s3, comp), 'origocrust', '3c. 空带+窗口内 → 放出晶体外壳');
  assertEq(s3.items, [{ itemId: 'origocrust', progress: 0.2, delta: 0 }],
    '3c2. 物品注入段首 progress=beltPhase（物品=实体 pointer，T2.1 约定）');
  assertEq(comp.bufferOutput[0], { itemId: 'origocrust', count: 1 },
    '3c3. 输出槽 count-1（未到 0 保持锁定）');
  // 入口间距（一格一物品）: 段上已有物品 → 无论位置如何都不再接收
  assertEq(tryEmitToBelt(mk([['origocrust', 0.5]]), comp), null,
    '3d. 段上已有物品@0.5 → null（一格一物品，只往空段注入）');
  const before = comp.bufferOutput[0].count;
  assertEq(tryEmitToBelt(mk([['origocrust', 0.05]]), comp), null,
    '4a. 段上已有物品@0.05（哪怕远在入口附近）→ null（一格一物品）');
  assertEq(comp.bufferOutput[0].count, before, '4b. 输出槽数量不变（物品留在输出槽）');
  comp.bufferOutput[0] = { itemId: 'origocrust', count: 1 };
  tryEmitToBelt(mk([]), comp);
  assertEq(comp.bufferOutput[0], { itemId: null, count: 0 }, '3d2. 扣到 0 → 槽解锁（一槽一物，A8 §2.2）');
}

// ═══════════════════ BeltSystem + MachineSystem 集成 ═══════════════════
console.log('[端口出货集成（真实 World，belt→machine 每 Tick）]');
const DT = 50;
const world = new World();
const beltSys = new BeltSystem();
const machineSys = new MachineSystem(recipeIndex, registry);
const log: Array<{ type: string; message: string }> = [];
machineSys.onEvent = (e) => log.push({ type: e.type, message: e.message });

const place = (gx: number, gy: number, dir: 0 | 90 | 180 | 270 = 0): BuildingComp => {
  const def = BUILDING_DEFINITIONS.refining_unit;
  const handle = world.createEntity();
  world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
  const comp: BuildingComp = {
    definitionId: 'refining_unit', direction: dir, state: 'idle',
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
    beltSys.update(world, DT); // DD-010: 先推进带上物品/相位
    machineSys.update(world, DT); // 同 Tick 出货（注入的物品下一 Tick 起推进）
  }
};

// 5/6: happy path —— 精炼炉(5,5) 顶中输出端口 (6,5)，接收带链 (6,4)→(6,0) 朝上 ×5
BeltSystem.beltPhase = 0;
const fA = place(5, 5);
fA.bufferOutput[0] = { itemId: 'origocrust', count: 5 };
const chain = [belt(6, 4, 270), belt(6, 3, 270), belt(6, 2, 270), belt(6, 1, 270), belt(6, 0, 270)];
tick(280); // 5 件 × ~40 Tick/件（空段+相位窗口节流）+ 行程 + 裕量
assertEq(fA.bufferOutput[0].count, 0, '5a. 输出槽 5 件全部上带（递减至 0）');
assertEq(chain.reduce((n, s) => n + s.items.length, 0), 5, '5b. 带上共 5 件');
assert(chain.every((s) => s.items.length === 1),
  '5c. 每段恰 1 件（一格一物品——满带堵塞=每格一件停在格中心）');
assert(chain.every((s) => near(s.items[0].progress, 0.5)),
  '5d. 各件停在格中心 0.50（注入相位 ≤ STOP_MAX + 断头钳制，无后跳）');
const events5 = log.filter((e) => e.type === 'output');
assertEq(events5.length, 5, '5e. 5 条 output 事件（每件一条）');
assert(events5.every((e) => e.message.includes('输出 晶体外壳 ×1（输出口2 → 传送带）')),
  '5f. 事件消息: "精炼炉: 输出 晶体外壳 ×1（输出口2 → 传送带）"（顶中口=定义序#1，T2.10 起消息带端口序号）');

// 6: 流动过程不变量——重跑一遍，中途采样每段 ≤ 1 件
BeltSystem.beltPhase = 0;
const fA2 = place(30, 5);
fA2.bufferOutput[0] = { itemId: 'origocrust', count: 5 };
const chain2 = [belt(31, 4, 270), belt(31, 3, 270), belt(31, 2, 270), belt(31, 1, 270), belt(31, 0, 270)];
let midFlowOk = true;
for (let t = 0; t < 200; t++) {
  tick(1);
  if (chain2.some((s) => s.items.length > 1)) { midFlowOk = false; break; }
}
assert(midFlowOk, '6. 流动全程任意时刻每段 ≤ 1 件（一格一物品不变量）');

// 7/8: 满带留槽 → 疏通恢复（1 格断头带）
BeltSystem.beltPhase = 0;
const fB = place(15, 5); // 输出端口 (16,5)，接收带 (16,4) 断头
const sB = belt(16, 4, 270);
fB.bufferOutput[0] = { itemId: 'origocrust', count: 5 };
tick(120); // 1 件上带@0.5 即满（空段+相位窗口 ~40 Tick 内），120 Tick 裕量
assertEq(sB.items.length, 1, '7a. 断头带 1 件@格中心即满（一格一物品）');
assert(near(sB.items[0].progress, 0.5), '7b. 物品停在 0.50（钳制位，注入相位恒 ≤ STOP_MAX → 无后跳）');
assertEq(fB.bufferOutput[0].count, 4, '7c. 其余 4 件留在输出槽（满带 → 物品留在输出槽）');
tick(60); // 停稳观察: 不再有新物品上带
assertEq(fB.bufferOutput[0].count, 4, '7d. 停留期间输出槽保持不变（每 Tick 重试均被一格一件拒绝）');
sB.items.splice(0, 1); // 取走带上物品（模拟下游取货）
tick(100); // 下一相位窗口放出 1 件
assert(fB.bufferOutput[0].count < 4, '8. 疏通后输出槽物品继续上带（带腾位即恢复）');

// 9: 方向判定 —— 同格但朝右（平行经过，入口在左侧 (25,4) 不是端口 (26,5)）→ 永不接收
BeltSystem.beltPhase = 0;
const fC = place(25, 5); // 输出端口 (26,5)
const sC = belt(26, 4, 0); // 朝右: 入口侧 (25,4)，出口 (27,4)——入口不朝向端口
fC.bufferOutput[0] = { itemId: 'origocrust', count: 3 };
tick(100);
assertEq(sC.items.length, 0, '9a. 平行经过的带 → 永不接收（A9 §6.7 入口朝向判定）');
assertEq(fC.bufferOutput[0].count, 3, '9b. 物品全部留在输出槽');

// 11: 旋转设备的端口旋转出货
BeltSystem.beltPhase = 0;
const f90 = place(5, 12, 90);  // 输出端口右列 (7,12..14)，接收带 (8,13) 朝右
belt(8, 13, 0);
const f180 = place(10, 12, 180); // 输出端口底排 (10..12,14)，接收带 (11,15) 朝下
belt(11, 15, 90);
const f270 = place(15, 12, 270); // 输出端口左列 (15,12..14)，接收带 (14,13) 朝左
belt(14, 13, 180);
f90.bufferOutput[0] = { itemId: 'origocrust', count: 1 };
f180.bufferOutput[0] = { itemId: 'origocrust', count: 1 };
f270.bufferOutput[0] = { itemId: 'origocrust', count: 1 };
tick(45); // 1 个完整相位周期内必有一次 ≤0.5 窗口
assertEq(f90.bufferOutput[0].count, 0, '11a. 90° 精炼炉（输出在右列）→ 右侧背离带出货');
assertEq(f180.bufferOutput[0].count, 0, '11b. 180° 精炼炉（输出在底排）→ 下方背离带出货');
assertEq(f270.bufferOutput[0].count, 0, '11c. 270° 精炼炉（输出在左列）→ 左侧背离带出货');

// 12: 每端口每 Tick 至多 1 件（3 输出端口 × 各 1 条接收带 → 同 Tick 共 3 件；单输出槽供 3 端口）
BeltSystem.beltPhase = 0.4; // 下一 Tick beltPhase=0.425 ≤ 0.5，窗口内
const fD = place(5, 20); // 输出端口顶排 (5,20)(6,20)(7,20)
belt(5, 19, 270);
belt(6, 19, 270);
belt(7, 19, 270);
fD.bufferOutput[0] = { itemId: 'origocrust', count: 5 };
tick(1);
assertEq(fD.bufferOutput[0].count, 2, '12a. 同 Tick 3 个端口各出 1 件（5→2）');
tick(1);
assertEq(fD.bufferOutput[0].count, 2, '12b. 次 Tick 不再出（带上物品@0.425 占住入口间距，等其离开）');

// 13: 全链路 —— A 注矿生产 → 产物上带 → 上升两段 → B 输入端口吸入
BeltSystem.beltPhase = 0;
const fE = place(20, 12); // A: 占 (20..22,12..14)，顶中输出端口 (21,12)
belt(21, 11, 270); // 接收带 (21,11)，出口侧 (21,10)
belt(21, 10, 270); // 第二段 (21,10)，出口侧 (21,9) = B 底中输入端口
const fF = place(20, 7); // B: 占 (20..22,7..9)，底中输入端口 (21,9)
fE.bufferInput[0] = { itemId: 'originium_ore', count: 2 };
tick(140); // 启动+2s 计时+相位窗口出货+1.5 格行程+吸入 ≈ 85 Tick，裕量
assert(log.some((e) => e.type === 'settle' && e.message.includes('晶体外壳')),
  '13a. A 生产结算产出晶体外壳（T2.5）');
assert(log.some((e) => e.type === 'output' && e.message.includes('晶体外壳')),
  '13b. A 输出晶体外壳到传送带（T2.7）');
assert(log.some((e) => e.type === 'input' && e.message.includes('吸入 晶体外壳 ×1')),
  '13c. B 从传送带吸入晶体外壳（T2.6，全链路 输入→生产→输出→传送带→下游输入 打通）');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
