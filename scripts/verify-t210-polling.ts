// T2.10 验证: 端口轮询系统（输入指针轮询 + 输出队列轮转）
// 依据: implementation-phase-2.md T2.10、A8 §4.1(输入轮询)/§4.2(输出轮询)、
//       A3 §3.2(轮询规则)、精炼炉设备说明.md（先到先得排名序(2026-09-02 用户拍板)、
//       满载指针不重置、堵塞端口跳过、恢复追加队尾）
//
// 用法: node --experimental-strip-types scripts/verify-t210-polling.ts
//
// 断言（全部走真实 World，DD-010 顺序 belt→machine 每 Tick）:
//   输入轮询 (A8 §4.1):
//     I1. 补货顺序 左→中→右 轮转: 满槽每次结算腾 1 位 → 依次 输入口1/2/3/1
//         （且未轮到的端口物品原位不动——"A 补货时 B、C 停止"）
//     I2. 满载冻结: 全部输入槽满 → 不预约、指针保持不动；手动置指针=2 后腾位
//         → 从右口补货（指针不重置回 0）
//     I3. 中间端口无供给带 → 跳过不卡住: 补货序列 左→右
//     I4. 中间端口类型不符 → 跳过: 槽锁晶体外壳、中带源矿 → 补货序列 左→右，
//         中带物品留在门口
//   输出轮询 (A8 §4.2):
//     O1. 同 Tick 多口各出 1 件按 左→中→右、成功者移队尾；货尽停发不误标堵塞
//         （剩余端口保留在队列中，补货后从队首继续）
//     O2. 无接收带/满带的端口移出队列（堵塞集=全部−队列），货物留槽
//     O3. 相位窗口外(beltPhase > STOP_MAX)整步跳过且**不动队列**
//     O4. 堵塞端口恢复探测成功 → 出货并回到活跃队列（恢复前活跃口优先于恢复口，
//         即"追加到当前轮询顺序末尾"的次序语义）
import { readFileSync } from 'node:fs';
import { World } from '../src/game/ECS.ts';
import {
  parseItemCsv,
  productItemsFromRecipeCsv,
  EXTRA_ITEM_DEFS,
  buildItemRegistry,
} from '../src/game/data/items.ts';
import { parseRecipeCsv, buildRecipeIndex } from '../src/game/data/recipes.ts';
import {
  BUILDING_DEFINITIONS,
  createOutputPollQueue,
} from '../src/game/data/buildings.ts';
import { createBufferSlots, consumeFromSlot } from '../src/game/systems/machine/BufferOps.ts';
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

// ═══════════════════ 集成测试装置 ═══════════════════
const DT = 50;
/** 每个场景独立 World（互不串扰）。 */
function makeScene(): {
  world: World;
  place: (gx: number, gy: number, dir?: 0 | 90 | 180 | 270) => BuildingComp;
  belt: (gx: number, gy: number, direction: 0 | 90 | 180 | 270, items?: Array<[string, number]>) => BeltSegmentComp;
  tick: (n?: number) => void;
  clearBelts: () => void;
  inputPortEvents: () => number[];
  outputPortEvents: () => number[];
} {
  const world = new World();
  const beltSys = new BeltSystem();
  const machineSys = new MachineSystem(recipeIndex, registry);
  const events: Array<{ type: string; portIndex?: number }> = [];
  machineSys.onEvent = (e) => events.push({ type: e.type, portIndex: e.portIndex });
  const place = (gx: number, gy: number, dir: 0 | 90 | 180 | 270 = 0): BuildingComp => {
    const def = BUILDING_DEFINITIONS.refining_unit;
    const handle = world.createEntity();
    world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    const comp: BuildingComp = {
      definitionId: 'refining_unit', direction: dir, state: 'idle',
      paused: false,
      bufferInput: createBufferSlots(def.inputSlotCount),
      bufferOutput: createBufferSlots(def.outputSlotCount),
      inputPollIndex: 0, outputPollQueue: createOutputPollQueue(def),
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
      segmentIndex: 0, phaseOffset: 0, items: items.map(([itemId, progress]) => ({ itemId, progress, delta: 0 })),
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
  return {
    world, place, belt, tick,
    clearBelts: () => {
      for (const h of world.query('BeltSegmentComp')) {
        const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp');
        if (seg) seg.items.length = 0;
      }
    },
    inputPortEvents: () => events.filter((e) => e.type === 'input').map((e) => e.portIndex ?? -1),
    outputPortEvents: () => events.filter((e) => e.type === 'output').map((e) => e.portIndex ?? -1),
  };
}

/** 精炼炉 (gx,gy) 的三个输入口供给格（底边下方一排，dir=0）。 */
const supplyCells = (gx: number, gy: number): Array<[number, number]> =>
  [[gx, gy + 3], [gx + 1, gy + 3], [gx + 2, gy + 3]];
/** 精炼炉 (gx,gy) 的三个输出口接收格（顶边上方一排，dir=0）。 */
const receiveCells = (gx: number, gy: number): Array<[number, number]> =>
  [[gx, gy - 1], [gx + 1, gy - 1], [gx + 2, gy - 1]];
/** 用晶体外壳作"原料"——精炼炉无以它为原料的配方 → 设备恒 idle，排除生产结算干扰。 */
const ITEM = 'origocrust';

// ═══════════════════ 输入轮询 ═══════════════════
console.log('[I1. 同刻到达并列定义序: 补货顺序 左→中→右 轮转（满槽每次腾 1 位）]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0;
  const f = sc.place(40, 12);
  f.bufferInput[0] = { itemId: ITEM, count: 50 };
  f.bufferOutput[0] = { itemId: ITEM, count: 50 }; // 双保险: 即使有配方匹配也保持 blocked
  const supplies = supplyCells(40, 12).map(([x, y]) => sc.belt(x, y, 270, [[ITEM, 0.5]]));

  const seq: number[] = [];
  for (let round = 0; round < 4; round++) {
    // 调试级重置: 清掉上一轮已被预约(entering)的物品，三个门口重新摆上新鲜物品
    //（模拟"三条传送带持续供料、槽位稀缺"的现实约束）
    sc.clearBelts();
    for (const s of supplies) s.items.push({ itemId: ITEM, progress: 0.5, delta: 0 });
    consumeFromSlot(f.bufferInput[0], 1); // 模拟一次结算扣料: 满→49（恰好 1 个空位）
    const before = sc.inputPortEvents().length;
    sc.tick(1);
    const ev = sc.inputPortEvents().slice(before);
    seq.push(...ev);
    if (round < 3) {
      assertEq(ev.length, 1, `I1-r${round}. 本次只补 1 件（补满即冻结，其余端口停止）`);
      const waiting = supplies.filter((s, i) => i !== ev[0] && s.items.length > 0);
      assert(waiting.every((s) => s.items[0]?.entering !== true),
        `I1-r${round}. 未轮到端口的物品停在门口未被预约（${waiting.length} 条带在等）`);
    }
  }
  assertEq(seq, [0, 1, 2, 0], 'I1-a. 四轮补货端口序列 = 左→中→右→左（三口同刻到货，排名并列按定义序）');
  assertEq(f.inputPollIndex, 1, 'I1-b. 指针停在下次该补的端口（中口 idx1）');
  assert(supplies[0].items.some((it) => it.entering === true),
    'I1-c. 第 4 轮补货来自左口（物品已标记 entering 走进设备）');
  assertEq(f.bufferInput[0].count, 50, 'I1-d. 输入槽回满 50/50');
}

console.log('[I2. 满载冻结：指针保持不动、不重置]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0;
  const f = sc.place(50, 12);
  f.bufferInput[0] = { itemId: ITEM, count: 50 };
  supplyCells(50, 12).forEach(([x, y]) => sc.belt(x, y, 270, [[ITEM, 0.5]]));

  sc.tick(3);
  assertEq(sc.inputPortEvents(), [], 'I2-a. 满载时不预约任何物品');
  assertEq(f.inputPollIndex, 0, 'I2-b. 指针保持不动');

  f.inputPollIndex = 2; // 人为拨到右口（模拟此前已轮转过两口的现场）
  consumeFromSlot(f.bufferInput[0], 1);
  sc.tick(1);
  assertEq(sc.inputPortEvents(), [2], 'I2-c. 腾出 1 位后从指针所指的右口(idx2)补货——不重置回左口');
  assertEq(f.inputPollIndex, 0, 'I2-d. 补货后指针前进并回绕（下一轮回左口）');
}

console.log('[I3. 中间端口无供给带 → 跳过不卡住]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0;
  const f = sc.place(60, 12);
  f.bufferInput[0] = { itemId: ITEM, count: 50 };
  const cells = supplyCells(60, 12);
  sc.belt(cells[0][0], cells[0][1], 270, [[ITEM, 0.5]]); // 只有左、右两条带
  sc.belt(cells[2][0], cells[2][1], 270, [[ITEM, 0.5]]);
  for (let round = 0; round < 2; round++) {
    consumeFromSlot(f.bufferInput[0], 1);
    sc.tick(1);
  }
  assertEq(sc.inputPortEvents(), [0, 2], 'I3-a. 补货序列 左→右（中间口无带被跳过，指针照常前进）');
}

console.log('[I4. 中间端口类型不符 → 跳过，物品留在门口]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0;
  const f = sc.place(70, 12);
  f.bufferInput[0] = { itemId: ITEM, count: 50 }; // 槽锁晶体外壳
  const cells = supplyCells(70, 12);
  sc.belt(cells[0][0], cells[0][1], 270, [[ITEM, 0.5]]);
  const midBelt = sc.belt(cells[1][0], cells[1][1], 270, [['originium_ore', 0.5]]); // 中带源矿≠锁定类型
  sc.belt(cells[2][0], cells[2][1], 270, [[ITEM, 0.5]]);
  for (let round = 0; round < 2; round++) {
    consumeFromSlot(f.bufferInput[0], 1);
    sc.tick(1);
  }
  assertEq(sc.inputPortEvents(), [0, 2], 'I4-a. 补货序列 左→右（中口类型不符被跳过，A8 §4.1 失败也前进指针）');
  assert(midBelt.items.length === 1 && midBelt.items[0].entering !== true,
    'I4-b. 中带源矿留在门口未被预约（等待槽型匹配或解锁）');
}

console.log('[I5. 先到先得排名序: 中口先到 → 满载轮转 中→右→左（2026-09-02 用户拍板）]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0;
  const f = sc.place(80, 12);
  const cells = supplyCells(80, 12);
  // 三条带先后来货（真实玩法 = 三带速度/进度不一/先后连接）: 只有中口先有货 →
  // 空槽阶段见门就收并建立最早排名，右口次之，左口最晚。
  const mid = sc.belt(cells[1][0], cells[1][1], 270, [[ITEM, 0.5]]);
  sc.tick(1); // 中口吸入
  const right = sc.belt(cells[2][0], cells[2][1], 270, [[ITEM, 0.5]]);
  sc.tick(1); // 右口吸入
  const left = sc.belt(cells[0][0], cells[0][1], 270, [[ITEM, 0.5]]);
  sc.tick(1); // 左口吸入
  assertEq(f.bufferInput[0].count, 3, 'I5-a. 三口先后各吸 1 件（空槽阶段见门就收，无轮询串行）');
  const rank = f.inputArrivalRank!;
  assert(rank[1] < rank[2] && rank[2] < rank[0],
    `I5-b. 先到排名戳记 中→右→左（一次性: ${JSON.stringify(rank)}）`);
  // 补满到 50: 未满载阶段每 Tick 走访全部口、同 Tick 多口齐吸（规则2 同时进料）
  for (let i = 0; f.bufferInput[0].count < 50 && i < 40; i++) {
    sc.clearBelts();
    for (const s of [left, mid, right]) s.items.push({ itemId: ITEM, progress: 0.5, delta: 0 });
    sc.tick(1);
  }
  assertEq(f.bufferInput[0].count, 50, 'I5-c. 输入槽补满 50（未满载阶段三口齐吸）');
  // 满载腾位轮转: 每轮结算扣 1 + 三口都有门口件 → 按先到排名序循环补货
  const seqPorts: number[] = [];
  for (let round = 0; round < 4; round++) {
    sc.clearBelts();
    for (const s of [left, mid, right]) s.items.push({ itemId: ITEM, progress: 0.5, delta: 0 });
    consumeFromSlot(f.bufferInput[0], 1);
    const before = sc.inputPortEvents().length;
    sc.tick(1);
    seqPorts.push(...sc.inputPortEvents().slice(before));
  }
  // 先到排名序 [中(1), 右(2), 左(0)]；循环不变式: 每次补货沿排名序前进到下一口
  const rankSeq = [1, 2, 0];
  const nextOf = (p: number) => rankSeq[(rankSeq.indexOf(p) + 1) % 3];
  assert(new Set(seqPorts).size === 3,
    `I5-d. 4 次腾位覆盖三口（实际 ${JSON.stringify(seqPorts)}）`);
  assert(seqPorts.slice(0, 3).every((p, i) => nextOf(p) === seqPorts[i + 1]),
    `I5-e. 补货循环沿先到排名序 中→右→左（实际 ${JSON.stringify(seqPorts)}）`);
}

console.log('[I6. 迟到的新带追加轮询末尾]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0;
  const f = sc.place(90, 12);
  const cells = supplyCells(90, 12);
  const left = sc.belt(cells[0][0], cells[0][1], 270, [[ITEM, 0.5]]);
  sc.tick(1); // 左先到
  const mid = sc.belt(cells[1][0], cells[1][1], 270, [[ITEM, 0.5]]);
  sc.tick(1); // 中次到
  for (let i = 0; f.bufferInput[0].count < 50 && i < 40; i++) {
    sc.clearBelts();
    for (const s of [left, mid]) s.items.push({ itemId: ITEM, progress: 0.5, delta: 0 });
    sc.tick(1);
  }
  assertEq(f.bufferInput[0].count, 50, 'I6-a. 左/中两口补满 50');
  // 右带此刻才连接来货 → 先到排名最晚，轮询序追加到末尾: 左→中→右
  const right = sc.belt(cells[2][0], cells[2][1], 270, [[ITEM, 0.5]]);
  const seqPorts: number[] = [];
  for (let round = 0; round < 4; round++) {
    sc.clearBelts();
    for (const s of [left, mid, right]) s.items.push({ itemId: ITEM, progress: 0.5, delta: 0 });
    consumeFromSlot(f.bufferInput[0], 1);
    const before = sc.inputPortEvents().length;
    sc.tick(1);
    seqPorts.push(...sc.inputPortEvents().slice(before));
  }
  const nextOf = (p: number) => (p + 1) % 3;
  assert(new Set(seqPorts).size === 3
    && seqPorts.slice(0, 3).every((p, i) => nextOf(p) === seqPorts[i + 1]),
    `I6-b. 迟到右口追加末尾: 补货循环 左→中→右（实际 ${JSON.stringify(seqPorts)}）`);
}

// ═══════════════════ 输出轮询 ═══════════════════
console.log('[O1. 成功者移队尾；货尽停发不误标堵塞]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0.4; // tick 内 beltSys 推进后 0.425 ≤ STOP_MAX，窗口内
  const f = sc.place(80, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 2 }; // 只有 2 件货
  receiveCells(80, 12).forEach(([x, y]) => sc.belt(x, y, 270));
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [0, 1], 'O1-a. 前 2 件按 左→中→右 出货，第 3 口轮到时货尽停发');
  // 成功者移队尾 ×2 → 队列旋转两位；轮空的 idx2 保留活跃（槽空≠端口堵塞）
  assertEq(f.outputPollQueue, [2, 0, 1], 'O1-b. 队列 [2,0,1]: 成功者移队尾、轮空的口未被移出');
  f.bufferOutput[0] = { itemId: ITEM, count: 1 }; // 补 1 件货
  sc.clearBelts(); // 清空带上物品（模拟下游全部取走）
  BeltSystem.beltPhase = 0.4;
  sc.tick(1);
  assertEq(sc.outputPortEvents().slice(-1), [2], 'O1-c. 补货后从队列队首 idx2 继续（轮询次序记忆保持）');
}

console.log('[O2. 无接收带/满带 → 移出队列（堵塞集=全部−队列）]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0.4;
  const f = sc.place(90, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 5 };
  const cells = receiveCells(90, 12);
  sc.belt(cells[0][0], cells[0][1], 270); // 只有左、右有接收带，中间悬空
  sc.belt(cells[2][0], cells[2][1], 270);
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [0, 2], 'O2-a. 中间口无接收带被跳过，左右各出 1 件');
  assertEq(f.outputPollQueue, [0, 2], 'O2-b. 中间口已移出活跃队列（保持引用待恢复探测）');
  sc.tick(60); // 断头带 1 件即满 → 下个窗口两侧也进堵塞集
  assertEq(f.outputPollQueue, [], 'O2-c. 侧口满带后同样移出 → 队列清空（全部堵塞）');
  assertEq(f.bufferOutput[0].count, 3, 'O2-d. 共出货 2 件，其余 3 件留在输出槽');
}

console.log('[O3. 相位窗口外整步跳过且不动队列]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0.7; // > STOP_MAX 窗口外
  const f = sc.place(100, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 3 };
  const cells = receiveCells(100, 12);
  sc.belt(cells[1][0], cells[1][1], 270); // 只有中、右有接收带（若误处理会把 idx0 移出队列）
  sc.belt(cells[2][0], cells[2][1], 270);
  sc.tick(2);
  assertEq(sc.outputPortEvents(), [], 'O3-a. 窗口外零出货');
  assertEq(f.outputPollQueue, [0, 1, 2], 'O3-b. 队列原封不动（相位关闭是全局节奏而非端口故障）');
  BeltSystem.beltPhase = 0.4;
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [1, 2], 'O3-c. 窗口内恢复: idx0 移出、idx1/idx2 依次出货');
  assertEq(f.outputPollQueue, [1, 2], 'O3-d. idx0 移出、idx1/idx2 各自轮转到队尾');
}

console.log('[O4. 堵塞恢复 → 回到活跃队列且排在既有活跃口之后]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0.4;
  const f = sc.place(120, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 4 };
  const c = receiveCells(120, 12);
  const bLeft = sc.belt(c[0][0], c[0][1], 270, [[ITEM, 0.5]]);   // 左: 预置满带（堵塞集）
  const bMid = sc.belt(c[1][0], c[1][1], 270, [[ITEM, 0.5]]);    // 中: 预置满带（堵塞集）
  sc.belt(c[2][0], c[2][1], 270);                                 // 右: 空（唯一活跃口）
  f.outputPollQueue = [2]; // 现场: 只有右口活跃
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [2], 'O4-a. 初始只有右口活跃并出货');
  bLeft.items.length = 0; // 同时疏通左、中（模拟下游取走）
  bMid.items.length = 0;
  f.bufferOutput[0].count = 3; // 保证货量充足
  BeltSystem.beltPhase = 0.4;
  sc.tick(1);
  // 右口已被阶段1 的货占满 → 本 Tick 移出；恢复探测按下标序找到左、中 → 依次出货并追加队尾。
  // 若实现是"插回原位/重置定义序"，恢复口不会稳定地以 下标序 追加在轮空判断之后出现。
  assertEq(sc.outputPortEvents(), [2, 0, 1], 'O4-b. 完整出货序 右→左→中: 先活跃口吃满本轮，恢复口随后按探测序补上');
  assert(f.outputPollQueue.includes(0) && f.outputPollQueue.includes(1),
    `O4-c. 恢复端口回到活跃队列（当前队列 ${JSON.stringify(f.outputPollQueue)}）`);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
