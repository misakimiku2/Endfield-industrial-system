// T2.6 验证: 传送带 → 设备输入对接（端口吸入: 连接判定 + progress=0.5 触发 + 满槽堵停 + 疏通恢复）
// 依据: implementation-phase-2.md T2.6、A9 §3.3(端口吸入)/§3.5(疏通)/§3.6(副作用)/§6.7(连接判定)、
//       A8 §2.1(输入槽规则)/§4.1(每端口每Tick至多1件)/§7 步骤2(输入物流)
//
// 用法: node --experimental-strip-types scripts/verify-t26-input-port.ts
//
// 断言:
//   IntakeOps 纯逻辑:
//     1. inputPortCells 端口旋转: 精炼炉 0°→底排 / 90°→左列 / 180°→顶排 / 270°→右列
//     2. findFeederBelt 连接判定: 指向端口格的段命中；方向不符 / 不相邻 → null
//     3. tryAbsorbHeadItem: 空段→null；队首未到门口(0.4)→null；到门口+空槽→吸入(移除+锁定+1)
//     4. tryAbsorbHeadItem: 槽满→null（物品留在传送带）；锁定异类型→null
//   BeltSystem + MachineSystem 集成（真实 World，DD-010 顺序 belt→machine）:
//     5. 物品从段首走到门口(0.5) → 同 Tick 吸入: 段上物品消失、输入槽 源矿 ×1 (已锁定)
//     6. 吸入事件消息: "精炼炉: 吸入 源矿 ×1（传送带 → 输入槽）"
//     7. 输入槽满 50/50 → 物品停在门口 progress=0.5 不动，数量不变
//     8. 疏通恢复: 扣 1 腾位 → 门口物品被吸入 → 回到 50/50
//     9. 类型锁定: 槽锁蓝铁矿、带上是源矿 → 物品停在门口不吸入
//    10. 方向必须指向端口: 同一格但方向背离 → 永不吸入
//    11. 输出端口不吸入 / 液体端口不吸入（只认 type='input'）
//    12. 旋转设备: 90°/180°/270° 精炼炉的输入端口侧各有一条指向带 → 均吸入
//    13. 每端口每 Tick 至多 1 件: 两件物品(0.5/0.25) → 首 Tick 只吸队首，队尾随后到达再吸
//    14. 多端口同 Tick 各吸 1 件: 三条供给带各 1 件在门口 → 同 Tick 全部吸入（单输入槽合堆 ×3）
//    15. 跨段流动到门口: 两段链物品从上游段出发 → 跨段 → 到门口吸入
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
import { createBufferSlots, consumeFromSlot } from '../src/game/systems/machine/BufferOps.ts';
import {
  inputPortCells,
  buildBeltCellIndex,
  findFeederBelt,
  tryAbsorbHeadItem,
  PORT_ENTER_PROGRESS,
} from '../src/game/systems/machine/IntakeOps.ts';
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

// ═══════════════════ IntakeOps 纯逻辑 ═══════════════════
console.log('[inputPortCells 端口旋转]');
assertEq(inputPortCells(5, 5, FURNACE, 0).map((c) => [c.x, c.y]), [[5, 7], [6, 7], [7, 7]],
  '1a. 0°（默认）: 输入端口在底排 (5,7)(6,7)(7,7)');
assertEq(inputPortCells(5, 5, FURNACE, 90).map((c) => [c.x, c.y]), [[5, 5], [5, 6], [5, 7]],
  '1b. 90°: 输入端口转到左列 (5,5)(5,6)(5,7)');
assertEq(inputPortCells(5, 5, FURNACE, 180).map((c) => [c.x, c.y]), [[7, 5], [6, 5], [5, 5]],
  '1c. 180°: 输入端口转到顶排（定义序 左→中→右 旋转后物理位置反序）');
assertEq(inputPortCells(5, 5, FURNACE, 270).map((c) => [c.x, c.y]), [[7, 7], [7, 6], [7, 5]],
  '1d. 270°: 输入端口转到右列（同上，定义序旋转）');
assertEq(PORT_ENTER_PROGRESS, 0.5, '1e. 吸入触发点 = 0.5（格中心，与 BeltSystem.STOP_MAX 同源）');

console.log('[findFeederBelt 连接判定]');
{
  const w = new World();
  const at = (gx: number, gy: number, d: 0 | 90 | 180 | 270): void => {
    const h = w.createEntity();
    w.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    w.addComponent(h, 'BeltSegmentComp', {
      chainId: 'c', direction: d, isCorner: false, isTail: true,
      segmentIndex: 0, phaseOffset: 0, items: [],
    });
  };
  at(6, 8, 270); // (6,8) 朝上 → 指向端口格 (6,7) ✓
  at(7, 8, 0);   // 同排但朝右 → 指向 (8,8)，不指向 (7,7) ✗
  at(6, 9, 270); // 朝上但隔了一格（指向 (6,8)）✗
  const idx = buildBeltCellIndex(w);
  assertEq(idx.size, 3, '2a. 格索引收录全部 3 段');
  assert(findFeederBelt(w, idx, { x: 6, y: 7 }) !== null,
    '2b. (6,8)朝上 → 是端口格 (6,7) 的供给带');
  assert(findFeederBelt(w, idx, { x: 7, y: 7 }) === null,
    '2c. (7,8)朝右 → 不是端口格 (7,7) 的供给带（方向背离设备）');
  assert(findFeederBelt(w, idx, { x: 3, y: 3 }) === null,
    '2d. 无任何段指向的格 → null（(6,9)朝上指向 (6,8)，若 (6,8) 是端口则它是对应供给带）');
}

console.log('[tryAbsorbHeadItem 吸入判定]');
{
  const comp: BuildingComp = {
    definitionId: 'refining_unit', direction: 0, state: 'idle',
    bufferInput: createBufferSlots(1), bufferOutput: createBufferSlots(1),
    currentRecipeId: null, progress: 0, elapsed: 0,
  };
  const mk = (items: Array<[string, number]>): BeltSegmentComp => ({
    chainId: 'c', direction: 270, isCorner: false, isTail: true,
    segmentIndex: 0, phaseOffset: 0,
    items: items.map(([itemId, progress]) => ({ itemId, progress, delta: 0 })),
  });
  assertEq(tryAbsorbHeadItem(mk([]), comp, 50), null, '3a. 空段 → null');
  assertEq(tryAbsorbHeadItem(mk([['originium_ore', 0.4]]), comp, 50), null,
    '3b. 队首未到门口(0.4) → null');
  const s3 = mk([['originium_ore', 0.5]]);
  assertEq(tryAbsorbHeadItem(s3, comp, 50), 'originium_ore', '3c. 到门口+空槽 → 吸入源矿');
  assertEq(s3.items.length, 0, '3c2. 吸入后段上物品消失（A9 §3.6）');
  assertEq(comp.bufferInput[0], { itemId: 'originium_ore', count: 1 },
    '3c3. 输入槽锁定源矿并 count+1');
  comp.bufferInput[0] = { itemId: 'originium_ore', count: 50 };
  const s4 = mk([['originium_ore', 0.5]]);
  assertEq(tryAbsorbHeadItem(s4, comp, 50), null, '4a. 槽满 50/50 → null（物品留在传送带）');
  assertEq(s4.items.length, 1, '4a2. 段上物品未移除');
  comp.bufferInput[0] = { itemId: 'ferrium_ore', count: 1 };
  const s5 = mk([['originium_ore', 0.5]]);
  assertEq(tryAbsorbHeadItem(s5, comp, 50), null, '4b. 槽锁蓝铁矿、带上是源矿 → null（类型不符）');
}

// ═══════════════════ BeltSystem + MachineSystem 集成 ═══════════════════
console.log('[端口吸入集成（真实 World，belt→machine 每 Tick）]');
const DT = 50;
const world = new World();
const beltSys = new BeltSystem();
const machineSys = new MachineSystem(recipeIndex, registry);
const inputEvents: string[] = [];
machineSys.onEvent = (e) => { if (e.type === 'input') inputEvents.push(e.message); };

const place = (gx: number, gy: number, dir: 0 | 90 | 180 | 270 = 0): BuildingComp => {
  const def = BUILDING_DEFINITIONS.refining_unit;
  const handle = world.createEntity();
  world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
  const comp: BuildingComp = {
    definitionId: 'refining_unit', direction: dir, state: 'idle',
    bufferInput: createBufferSlots(def.inputSlotCount),
    bufferOutput: createBufferSlots(def.outputSlotCount),
    currentRecipeId: null, progress: 0, elapsed: 0,
  };
  world.addComponent(handle, 'BuildingComp', comp);
  return comp;
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
    beltSys.update(world, DT); // DD-010: 物品先被推进/钳制到门口
    machineSys.update(world, DT); // 同 Tick 吸入（A5 §5.2"本 Tick 到达本 Tick 进入"）
  }
};

// 5/6: happy path —— 精炼炉(5,5) 底中输入端口 (6,7)，供给带 (6,8) 朝上
const f1 = place(5, 5);
const b1 = belt(6, 8, 270, [['originium_ore', 0]]);
tick(21); // 0→0.5 需 20 Tick，+1 裕量
assertEq(f1.bufferInput[0], { itemId: 'originium_ore', count: 1 },
  '5a. 物品走到门口 → 同 Tick 吸入: 输入槽 源矿 ×1 (已锁定)');
assertEq(b1.items.length, 0, '5b. 段上物品消失');
assert(inputEvents.some((m) => m.includes('吸入 源矿 ×1')),
  '6. 吸入事件消息: "精炼炉: 吸入 源矿 ×1（传送带 → 输入槽）"');

// 7/8: 满槽堵停 → 疏通恢复
const f2 = place(10, 5); // 底中端口 (11,7)，供给带 (11,8)
for (let i = 0; i < 50; i++) f2.bufferInput[0] = { itemId: 'originium_ore', count: f2.bufferInput[0].count + 1 };
const b2 = belt(11, 8, 270, [['originium_ore', 0]]);
tick(30); // 走到门口 + 停留观察
assert(b2.items.length === 1 && near(b2.items[0].progress, 0.5),
  `7a. 输入槽满 → 物品停在门口 progress=0.5（实际 ${b2.items[0]?.progress.toFixed(3)}）`);
assertEq(f2.bufferInput[0].count, 50, '7b. 停留期间输入槽数量不变（50/50）');
consumeFromSlot(f2.bufferInput[0], 1); // 腾出 1 个空位（模拟生产消耗）
tick(2);
assertEq(b2.items.length, 0, '8a. 疏通后门口物品被吸入（段上清空）');
assertEq(f2.bufferInput[0].count, 50, '8b. 输入槽回到 50/50');

// 9: 类型锁定拒绝
const f3 = place(15, 5); // 端口 (16,7)，供给带 (16,8)
f3.bufferInput[0] = { itemId: 'ferrium_ore', count: 1 };
const b3 = belt(16, 8, 270, [['originium_ore', 0]]);
tick(25);
assert(b3.items.length === 1 && near(b3.items[0].progress, 0.5),
  '9. 槽锁蓝铁矿、带上是源矿 → 物品停在门口不吸入');

// 10: 方向必须指向端口（同格但朝右 → 出口是 (7,8) 不是端口）
const f4 = place(20, 5); // 端口 (21,7)
const b4 = belt(21, 8, 0, [['originium_ore', 0]]);
tick(25);
assert(b4.items.length === 1 && near(b4.items[0].progress, 0.5) && f4.bufferInput[0].count === 0,
  '10. 同一格但方向背离端口 → 永不吸入（A9 §6.7 方向指向判定）');

// 11: 输出端口 / 液体端口不吸入（只认 type='input'）
const f5 = place(25, 5);
// 输出端口 (26,5)（顶排中），供给带 (26,4) 朝下指向它
const b5 = belt(26, 4, 90, [['originium_ore', 0]]);
// 液体端口 (25,6)（左中），供给带 (24,6) 朝右指向它
const b6 = belt(24, 6, 0, [['originium_ore', 0]]);
tick(25);
assert(b5.items.length === 1 && near(b5.items[0].progress, 0.5),
  '11a. 指向输出端口的带 → 不吸入');
assert(b6.items.length === 1 && near(b6.items[0].progress, 0.5),
  '11b. 指向液体端口的带 → 不吸入');
assertEq(f5.bufferInput[0].count, 0, '11c. 输入槽保持空');

// 12: 旋转设备的端口旋转吸入
const f90 = place(5, 12, 90); // 输入端口左列 (5,12..14)，供给带 (4,13) 朝右
belt(4, 13, 0, [['originium_ore', 0]]);
const f180 = place(10, 12, 180); // 输入端口顶排 (10..12,12)，供给带 (11,11) 朝下
belt(11, 11, 90, [['originium_ore', 0]]);
const f270 = place(15, 12, 270); // 输入端口右列 (17,12..14)，供给带 (18,13) 朝左
belt(18, 13, 180, [['originium_ore', 0]]);
tick(21);
assertEq(f90.bufferInput[0].count, 1, '12a. 90° 精炼炉（输入在左列）→ 左侧供给带吸入');
assertEq(f180.bufferInput[0].count, 1, '12b. 180° 精炼炉（输入在顶排）→ 上方供给带吸入');
assertEq(f270.bufferInput[0].count, 1, '12c. 270° 精炼炉（输入在右列）→ 右侧供给带吸入');

// 13: 每端口每 Tick 至多 1 件（一格一物品: 门口格只容 1 件，上游件依次到达再吸）
const f6 = place(5, 20); // 端口 (6,22)，供给链 (6,24)→(6,23)
const b7 = belt(6, 24, 270, [['originium_ore', 0.5]]); // 上游段，物品停在段中
belt(6, 23, 270, [['originium_ore', 0.5]]); // 门口段（下游）
tick(1);
assertEq(f6.bufferInput[0].count, 1, '13a. 首 Tick 只吸门口段队首 1 件');
assertEq(b7.items.length, 1, '13b. 上游件留在上游段（门口腾空后才开始前进）');
tick(40); // 上游件 0.5→1.0 跨段(20 Tick) + 门口 0→0.5(10 Tick) + 吸入，裕量
assertEq(b7.items.length, 0, '13c. 上游件跨段到达门口后被吸入（段上清空）');
assertEq(f6.bufferInput[0].count, 2, '13d. 输入槽 源矿 ×2（同槽合堆）');

// 14: 多端口同 Tick 各吸 1 件（三条供给带 → 三个输入端口）
const f7 = place(5, 28); // 占 (5..7,28..30)，端口 (5,30)(6,30)(7,30)
belt(5, 31, 270, [['originium_ore', 0.5]]);
belt(6, 31, 270, [['originium_ore', 0.5]]);
belt(7, 31, 270, [['originium_ore', 0.5]]);
tick(1);
assertEq(f7.bufferInput[0].count, 3, '14. 三条供给带各 1 件在门口 → 同 Tick 全部吸入（单输入槽 ×3）');

// 15: 跨段流动到门口（两段链: 物品从上游段段首出发 → 跨段 → 门口吸入）
const f8 = place(10, 28); // 占 (10..12,28..30)，端口 (11,30)，链 (11,32)→(11,31)
const bUp2 = belt(11, 32, 270, [['originium_ore', 0]]); // 上游段，物品从段首出发
belt(11, 31, 270); // 门口段（下游，空）
tick(62); // 1 格(40 Tick) + 半格(20 Tick) + 裕量
assertEq(f8.bufferInput[0].count, 1, '15. 两段链物品跨段到门口 → 吸入（跨段 + 端口对接连续路径）');
assertEq(bUp2.items.length, 0, '15b. 上游段已清空（物品顺利移交下游）');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
