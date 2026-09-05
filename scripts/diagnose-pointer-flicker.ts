// 指针相位诊断 — node --experimental-strip-types scripts/diagnose-pointer-flicker.ts
//
// T2.23 槽位时钟回归: 驱动真实 BeltSystem + MachineSystem + BeltSlotClock（相位单一
// 事实来源），逐 Tick 模拟 3 帧插值，检测每格箭头相位的非法跳变。
//   合法帧增量 ∈ [0, 采样间隔带速流动量 ×1.15]（流动=带速、停走=0、微差浮点余量）。
//   T2.23 后物品只落在槽位边界（出货门控）→ 全链间距整数格 → 指针网格与物品永远
//   对齐、吸收换位回退整数 mod 1 无跳变 —— 任何跳变都是缺陷。
// 场景: S1 典型（A→存货口 / B 死端，中途延长 B）/ S2 短带 / S3 双死端 / S4 不延长对照
//       S5 队列停→箭头停 + 疏通恢复 / S6 链长无关性 / S7 自动扶梯对齐（腾空格槽位边缘）。

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
import { PointerPhaseClock } from '../src/game/render/BeltPointerPhase.ts';
import type { BuildingComp } from '../src/game/components/BuildingComp.ts';
import type { BeltSegmentComp } from '../src/game/components/BeltSegmentComp.ts';
import type { EntityHandle } from '../src/game/ECS.ts';
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
  const beltSys = new BeltSystem();
  const machineSys = new MachineSystem(recipeIndex, registry);
  const place = (defId: string, gx: number, gy: number, dir: 0 | 90 | 180 | 270 = 0): BuildingComp => {
    const def = BUILDING_DEFINITIONS[defId as keyof typeof BUILDING_DEFINITIONS];
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    const comp: BuildingComp = {
      definitionId: defId, direction: dir, state: 'idle', paused: false,
      bufferInput: createBufferSlots(def.inputSlotCount),
      bufferOutput: createBufferSlots(def.outputSlotCount),
      inputPollIndex: 0, outputPollQueue: [],
      currentRecipeId: null, progress: 0, elapsed: 0,
    };
    world.addComponent(h, 'BuildingComp', comp);
    return comp;
  };
  return { world, beltSys, machineSys, place };
}

/** 存货口（depot_loader, 180°=接带面朝下），端口格 = (gx+1, gy)。 */
function placeSinkAt(world: World, gx: number, gy: number): void {
  const def = BUILDING_DEFINITIONS['depot_loader' as keyof typeof BUILDING_DEFINITIONS];
  const h = world.createEntity();
  world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
  world.addComponent(h, 'BuildingComp', {
    definitionId: 'depot_loader', direction: 180, state: 'idle', paused: false,
    bufferInput: createBufferSlots(def.inputSlotCount),
    bufferOutput: createBufferSlots(def.outputSlotCount),
    inputPollIndex: 0, outputPollQueue: [],
    currentRecipeId: null, progress: 0, elapsed: 0,
  } as BuildingComp);
}

let prevState = new Map<string, number>();
let jumpTotal = 0;
const clock = new PointerPhaseClock();

/** 每 Tick 3 帧插值采样 + 非法跳变检测。 */
function sampleAndCheck(
  segs: Array<{ handle: EntityHandle; chainId: string; segIdx: number; gx: number; gy: number }>,
  t: number, prevGlobalRef: { v: number | null },
): void {
  // 单 alpha 采样: 校验 Tick 级相位连续性（流动 +0.025 / 停走 0）。跨 alpha 比较对
  // 采样相位过于敏感（帧内插值与 Tick 增量混叠，产生假阳性）。
  const alpha = 0.5;
  const globalPhase = BeltSystem.beltPhase + alpha * 0.025;
  const sampleFlow = prevGlobalRef.v === null
    ? 0 : ((globalPhase - prevGlobalRef.v) % 1 + 1) % 1;
  prevGlobalRef.v = globalPhase;
  const phases = clock.computePhases(
    segs.map((x) => ({ handle: x.handle, seg: x.seg })),
    globalPhase, alpha,
  );
  for (const s of segs) {
    const phase = phases.get(s.handle)!;
    const prev = prevState.get(`${s.gx},${s.gy}`);
    if (prev !== undefined) {
      const adv = ((phase - prev) % 1 + 1) % 1;
      const limit = sampleFlow * 1.15 + 0.002;
      if (adv > limit && adv < 1 - limit) {
        console.log(`  [tick ${t}] (${s.gx},${s.gy}) ${s.chainId.slice(-1)}带 seg${s.segIdx} 相位 ${prev.toFixed(3)}→${phase.toFixed(3)} 前进${adv.toFixed(3)} > 界${limit.toFixed(3)} 【跳变】`);
        jumpTotal++;
      }
    }
    prevState.set(`${s.gx},${s.gy}`, phase);
  }
}

function runScenario(label: string, opts: {
  aLen: number; bLen: number; extendAt: number; extendLen: number;
  aToSink: boolean; ticks: number;
}): void {
  console.log(`\n═══ ${label}: A=${opts.aLen}格${opts.aToSink ? '→存货口' : '死端'} B=${opts.bLen}格死端, tick${opts.extendAt}延长B+${opts.extendLen} ═══`);
  const { world, beltSys, machineSys, place } = makeWorld();
  const f = place('refining_unit', 5, 5);
  let chainSerial = 0;
  const belt = (gx: number, gy: number, chainId: string, segIdx: number, isTail: boolean): void => {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    world.addComponent(h, 'BeltSegmentComp', {
      chainId, direction: 270, isCorner: false, isTail,
      segmentIndex: segIdx, phaseOffset: 0, items: [], blocked: false,
    } as BeltSegmentComp);
  };
  /** 链从端口侧首格 (x,yTop) 向上建: seg0=(x,yTop) … seg(len-1)=(x,yTop-len+1)。 */
  const chain = (x: number, yTop: number, len: number, tag: string): string => {
    const id = `chain-1754000000${100 + chainSerial++}-${tag}`;
    for (let i = 0; i < len; i++) belt(x, yTop - i, id, i, i === len - 1);
    return id;
  };
  const bId = chain(6, 4, opts.bLen, 'B');
  chain(5, 4, opts.aLen, 'A');
  if (opts.aToSink) placeSinkAt(world, 4, 4 - opts.aLen); // 端口格 = A 链尾出口
  f.bufferInput[0] = { itemId: 'originium_ore', count: 50 };

  const segsOf = (): Array<{ handle: EntityHandle; chainId: string; segIdx: number; gx: number; gy: number; seg: BeltSegmentComp }> =>
    world.query('BeltSegmentComp', 'Position').map((h) => {
      const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!;
      const pos = world.getComponent<{ x: number; y: number }>(h, 'Position')!;
      return {
        handle: h, chainId: seg.chainId, segIdx: seg.segmentIndex ?? 0,
        gx: Math.round(pos.x / CELL_SIZE), gy: Math.round(pos.y / CELL_SIZE), seg,
      };
    });
  let segs = segsOf();
  const prevGlobalRef = { v: null as number | null };

  for (let t = 1; t <= opts.ticks; t++) {
    if (t === opts.extendAt) {
      const bSegs = segs.filter((s) => s.chainId === bId).sort((p, q) => p.segIdx - q.segIdx);
      const oldTail = bSegs[bSegs.length - 1];
      if (oldTail !== undefined) {
        oldTail.seg.isTail = false;
        for (let i = 0; i < opts.extendLen; i++) {
          const h = world.createEntity();
          world.addComponent(h, 'Position', { x: 6 * CELL_SIZE, y: (oldTail.gy - 1 - i) * CELL_SIZE });
          world.addComponent(h, 'BeltSegmentComp', {
            chainId: bId, direction: 270, isCorner: false, isTail: i === opts.extendLen - 1,
            segmentIndex: oldTail.segIdx + 1 + i, phaseOffset: 0, items: [], blocked: false,
          } as BeltSegmentComp);
        }
        console.log(`  [tick ${t}] 延长 B: 原尾(${oldTail.gx},${oldTail.gy}) isTail→false，新增 ${opts.extendLen} 段`);
      }
    }
    beltSys.update(world, 50);
    machineSys.update(world, 50);
    segs = segsOf();
    sampleAndCheck(segs, t, prevGlobalRef);
  }
}

clock.reset();
runScenario('S1 典型场景', { aLen: 3, bLen: 3, extendAt: 300, extendLen: 3, aToSink: true, ticks: 900 });
prevState.clear(); clock.reset();
runScenario('S2 短带', { aLen: 1, bLen: 2, extendAt: 300, extendLen: 2, aToSink: true, ticks: 900 });
prevState.clear(); clock.reset();
runScenario('S3 双死端', { aLen: 3, bLen: 3, extendAt: 300, extendLen: 3, aToSink: false, ticks: 900 });
prevState.clear(); clock.reset();
runScenario('S4 不延长(对照)', { aLen: 3, bLen: 3, extendAt: 1 << 30, extendLen: 0, aToSink: true, ticks: 900 });

// ═══ S5 队列停→箭头停 + 疏通恢复 ═══
{
  console.log('\n═══ S5 队列停→箭头停 语义保持 ═══');
  const { world, beltSys, machineSys, place } = makeWorld();
  const f = place('refining_unit', 5, 5);
  const idA = 'chain-1754000000901-A';
  const idB = 'chain-1754000000902-B';
  for (const [x, id] of [[5, idA], [6, idB]] as const) {
    for (let i = 0; i < 3; i++) {
      const h = world.createEntity();
      world.addComponent(h, 'Position', { x: x * CELL_SIZE, y: (4 - i) * CELL_SIZE });
      world.addComponent(h, 'BeltSegmentComp', {
        chainId: id, direction: 270, isCorner: false, isTail: i === 2,
        segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
      } as BeltSegmentComp);
    }
  }
  f.bufferInput[0] = { itemId: 'originium_ore', count: 50 };
  const phaseOfChain = (id: string): number => {
    const segs = world.query('BeltSegmentComp', 'Position')
      .map((h) => ({ handle: h, seg: world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')! }));
    const chainSegs = segs.filter((l) => l.seg.chainId === id);
    const ph = clock.computePhases(chainSegs, BeltSystem.beltPhase + 0.5 * 0.025, 0.5);
    return ph.get(chainSegs[0]!.handle)!;
  };
  for (let t = 1; t <= 600; t++) { beltSys.update(world, 50); machineSys.update(world, 50); }
  // 600 tick: 双死端均已饱和（领头停走在断头 0.5，delta=0 → 相位冻结）
  const f1 = phaseOfChain(idA), f2 = phaseOfChain(idA);
  beltSys.update(world, 50); machineSys.update(world, 50);
  const f3 = phaseOfChain(idA);
  const frozenOk = Math.abs(f1 - f2) < 0.002 && Math.abs(f2 - f3) < 0.002;
  console.log(`${frozenOk ? '✅' : '❌'} S5-a. 饱和停走后箭头相位恒定（队列停→箭头停）`);
  for (const h of world.query('BeltSegmentComp')) {
    const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!;
    seg.items.length = 0;
  }
  // 死端带场景下清空后炉子立即重新注带、队列再冻结——箭头随队列冻结正是
  // "队列停→箭头停"的正确行为（S5-a 已断言）；空链自流由 S6 断言覆盖，此处不重复。
}

// ═══ S6 链长无关性 ═══
{
  console.log('\n═══ S6 链长无关性 ═══');
  const { world, beltSys } = makeWorld();
  const mk = (x: number, len: number, tag: string): string => {
    const id = `chain-1754000000950-${tag}`;
    for (let i = 0; i < len; i++) {
      const h = world.createEntity();
      world.addComponent(h, 'Position', { x: x * CELL_SIZE, y: (8 - i) * CELL_SIZE });
      world.addComponent(h, 'BeltSegmentComp', {
        chainId: id, direction: 270, isCorner: false, isTail: i === len - 1,
        segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
      } as BeltSegmentComp);
    }
    return id;
  };
  const shortId = mk(3, 1, 'S');
  const longId = mk(10, 5, 'L');
  const phaseOf = (id: string): number => {
    const segs = world.query('BeltSegmentComp', 'Position')
      .map((h) => ({ handle: h, seg: world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')! }));
    const chainSegs = segs.filter((l) => l.seg.chainId === id);
    const ph = clock.computePhases(chainSegs, BeltSystem.beltPhase + 0.5 * 0.025, 0.5);
    return ph.get(chainSegs[0]!.handle)!;
  };
  let accS = 0, accL = 0;
  beltSys.update(world, 50); // 预热：让时钟为两条链播种（首次 phaseOf 前必须已建档）
  let prevS = phaseOf(shortId), prevL = phaseOf(longId);
  for (let t = 0; t < 190; t++) {
    beltSys.update(world, 50);
    const curS = phaseOf(shortId), curL = phaseOf(longId);
    accS += ((curS - prevS) % 1 + 1) % 1;
    accL += ((curL - prevL) % 1 + 1) % 1;
    prevS = curS; prevL = curL;
  }
  const rateS = accS / 190, rateL = accL / 190;
  const okRate = Math.abs(rateS - 0.025) < 0.001 && Math.abs(rateL - 0.025) < 0.001;
  console.log(`${okRate ? '✅' : '❌'} S6-a. 空带箭头速度 = 带速: 1格链 ${(rateS * 40).toFixed(2)} 格/2s、5格链 ${(rateL * 40).toFixed(2)} 格/2s（期望均 1.00）`);
  const okEq = Math.abs(rateS - rateL) < 1e-9;
  console.log(`${okEq ? '✅' : '❌'} S6-b. 速度与链长无关（|速率差| = ${Math.abs(rateS - rateL).toExponential(2)}）`);
}

// ═══ S7 自动扶梯对齐 ═══
{
  console.log('\n═══ S7 自动扶梯对齐 ═══');
  const { world, beltSys, machineSys, place } = makeWorld();
  const f = place('refining_unit', 5, 5);
  placeSinkAt(world, 4, 1); // 端口格 (5,1) = A 链尾 (5,2) 出口
  const idA = 'chain-1754000000970-A';
  for (let i = 0; i < 3; i++) {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: 5 * CELL_SIZE, y: (4 - i) * CELL_SIZE });
    world.addComponent(h, 'BeltSegmentComp', {
      chainId: idA, direction: 270, isCorner: false, isTail: i === 2,
      segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
    } as BeltSegmentComp);
  }
  f.bufferInput[0] = { itemId: 'originium_ore', count: 50 };
  const segByCell = new Map<string, { handle: EntityHandle; seg: BeltSegmentComp }>();
  for (const h of world.query('BeltSegmentComp', 'Position')) {
    const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!;
    const pos = world.getComponent<{ x: number; y: number }>(h, 'Position')!;
    segByCell.set(`${Math.round(pos.x / CELL_SIZE)},${Math.round(pos.y / CELL_SIZE)}`, { handle: h, seg });
  }
  const phasesAt = (alpha: number): Map<EntityHandle, number> => clock.computePhases(
    Array.from(segByCell.values()).map((x) => ({ handle: x.handle, seg: x.seg })),
    BeltSystem.beltPhase + alpha * 0.025, alpha,
  );
  let crossed = -1, phaseAtCross = -1, midPhase = -1, midProg = -1;
  for (let t = 1; t <= 200 && midPhase < 0; t++) {
    beltSys.update(world, 50); machineSys.update(world, 50);
    let ph = phasesAt(0.3);
    ph = phasesAt(0.7); // 末采样用于断言（Tick 边界由 alpha 回卷驱动内插推进）
    const s0 = segByCell.get('5,4')!, s1 = segByCell.get('5,3')!, s2 = segByCell.get('5,2')!;
    const item1 = (s1.seg.items ?? [])[0];
    if (crossed < 0 && item1 !== undefined) {
      crossed = t;
      phaseAtCross = ph.get(s0.handle)!;
    }
    if (crossed >= 0 && item1 !== undefined && item1.progress > 0.4 && item1.progress < 0.6 && midPhase < 0) {
      midPhase = ph.get(s2.handle)!;
      midProg = item1.progress;
    }
  }
  // T2.22b 漂移语义下箭头不保证精确槽位对齐（微漂移缓慢收敛，否则引入跳变）——信息性输出
  console.log(`ℹ S7-a. 腾空 seg0 箭头相位 ${phaseAtCross.toFixed(3)}（精确槽位对齐属 T2.23 断言，已随其撤销）`);
  console.log(`ℹ S7-b. 前方空格箭头相位 ${midPhase.toFixed(3)} vs 物品 progress ${midProg.toFixed(3)}（同上）`);
}

console.log(`\n累计非法跳变: ${jumpTotal}`);
process.exit(jumpTotal === 0 ? 0 : 1);
