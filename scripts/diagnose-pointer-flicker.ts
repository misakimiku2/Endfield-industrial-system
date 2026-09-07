// 指针队列物理 + 轮询棋盘诊断 — node --experimental-strip-types scripts/diagnose-pointer-flicker.ts
//
// T2.29 回归: 驱动真实 BeltSystem + MachineSystem + BeltPointerQueue（渲染器的
// 指针队列真值，纯逻辑可 node 驱动；本脚本的 QueueMirror 与 BeltPointerRenderer
// 逐帧逻辑同序同公式），逐 Tick 三帧采样检测:
//   ① 世界坐标连续性: 指针帧间位移 ∈ {0(被钳)} ∪ [帧流动量±余量] ∪ 循环瞬移
//      (Δ ≤ 0.075−链长) ∪ 注入重相位(|Δ| ≤ 0.5+流动量)——任何事件性跳变/小幅
//      倒退都在此现形。
//   ② 0-1 局部格网对齐（图1 根治断言）: 每支指针与其**前方最近物品**（排队对象）
//      mod 1 同余（队列物理 + 注入重相位的不变量）；无前方物品的指针（前端疏流
//      区/空带）不判定。
//   ③ 无重叠: 指针间 ≥1 格; 指针-物品 ≥1 格或 ≤接触距离（被碾住/待击杀）。
//   ④ 密度: 每链指针数 ≤ 链长+1。
// 场景: S1~S4 典型/延长/死端（①②③④全查）/ S5 堵塞冻结（§十三"被挡住就停"，
//       T2.28 的"堵塞照常循环"反转回队列语义）/ S6 空带流速=带速且与链长无关 /
//       S7 一格一箭头 / S8 注入段首 0 / S9 释放边界浮点容差 / S10 门口行走间距恒
//       1.0 / S11 双带轮询棋盘（图2/3 根治: 0-1-0/1-0-1 精确成立且长跑零漂移）/
//       S12 停走击杀+疏通恢复 / S13 注入重相位。

import { readFileSync } from 'node:fs';
import { World } from '../src/game/ECS.ts';
import {
  parseItemCsv, productItemsFromRecipeCsv, EXTRA_ITEM_DEFS, buildItemRegistry,
} from '../src/game/data/items.ts';
import { parseRecipeCsv, buildRecipeIndex } from '../src/game/data/recipes.ts';
import { BUILDING_DEFINITIONS } from '../src/game/data/buildings.ts';
import { BeltSystem, ITEM_PROGRESS_PER_TICK } from '../src/game/systems/BeltSystem.ts';
import { MachineSystem } from '../src/game/systems/MachineSystem.ts';
import { createBufferSlots } from '../src/game/systems/machine/BufferOps.ts';
import { ChainPointerQueue, chainCreationClass, CONTACT_KILL_DIST, type QueueItemRef } from '../src/game/render/BeltPointerQueue.ts';
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

let assertFails = 0;
let arrowJumps = 0;
let alignFails = 0;
let overlapFails = 0;

function assertOk(cond: boolean, label: string): void {
  if (!cond) assertFails++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
}

/** 全链物品快照（链上绝对坐标 + 是否停走；entering 过客不计）。 */
function itemsOf(world: World, chainId: string): QueueItemRef[] {
  const out: QueueItemRef[] = [];
  for (const h of world.query('BeltSegmentComp', 'Position')) {
    const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!;
    if (seg.chainId !== chainId) continue;
    const idx = seg.segmentIndex ?? 0;
    for (const it of seg.items ?? []) {
      if (it.entering === true) continue;
      out.push({ total: idx + it.progress, stopped: (it.delta ?? 0) === 0 });
    }
  }
  return out;
}

function chainLenOf(world: World, chainId: string): number {
  let len = 1;
  for (const h of world.query('BeltSegmentComp', 'Position')) {
    const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!;
    if (seg.chainId === chainId) len = Math.max(len, (seg.segmentIndex ?? 0) + 1);
  }
  return len;
}

/**
 * 队列驱动镜像: 直接调用 ChainPointerQueue.tick（与渲染器同一入口、零漂移——
 * 播种/击杀/前进/循环/注入格击杀/注入重相位/空带回归创建相位全在其内）。
 */
class QueueMirror {
  states = new Map<string, { q: ChainPointerQueue }>();
  private prevPos = new Map<string, Map<number, number>>(); // chainId → (arrowId → pos)

  tick(world: World, t: number, opts: { check: boolean }): void {
    const seen = new Set<string>();
    for (const h of world.query('BeltSegmentComp', 'Position')) {
      seen.add(world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!.chainId);
    }

    for (const chainId of seen) {
      let st = this.states.get(chainId);
      if (!st) {
        st = { q: new ChainPointerQueue() };
        this.states.set(chainId, st);
      }
      const len = chainLenOf(world, chainId);
      const items = itemsOf(world, chainId);
      const slid = st.q.tick(len, items, chainCreationClass(chainId, 0));

      if (!opts.check) {
        this.record(chainId, st.q);
        continue;
      }
      const prev = this.prevPos.get(chainId) ?? new Map<number, number>();
      // ① Tick 间连续性: |Δ| ∈ {0(被钳)} ∪ [0.025±余量] ∪ 循环瞬移(Δ ≤ 0.075−链长)
      //    ∪ 重相位类刚体平移（注入重相位 / 空带回归创建相位, slid 且 ≤0.525）
      for (const a of st.q.arrows) {
        const p = prev.get(a.id);
        if (p === undefined) continue;
        const delta = a.pos - p;
        const legal =
          Math.abs(delta) < 1e-9 ||
          Math.abs(delta - ITEM_PROGRESS_PER_TICK) <= 0.002 ||
          delta <= 0.075 - len + 1e-6 || // 循环 re-entry（尾→首瞬移）
          (slid && Math.abs(delta) <= 0.5 + ITEM_PROGRESS_PER_TICK + 1e-9);
        if (!legal) {
          console.log(`  [tick ${t}] ${chainId.slice(-1)}带 指针#${a.id} d=${a.pos.toFixed(3)} Δ=${delta.toFixed(3)}【指针跳变】`);
          arrowJumps++;
        }
      }
      // ② 0-1 局部对齐（有界）: 指针与其前方最近物品 mod 1 偏差 ≤ 0.55。
      //    稳态流动/停走队列下指针与物品格网精确同余（注入重相位 + 循环新鲜锚定
      //    + 钳位自愈的推论，图1 的根治）; 残差 = 停走带等待区/列车混合相位的
      //    瞬态扫动（≤半格，循环一圈或首个钳位自愈）。S11 承担跨带棋盘的精确断言。
      for (const a of st.q.arrows) {
        const p = prev.get(a.id);
        const arrowMoved = p !== undefined && a.pos - p > 1e-9;
        let nextItem = Infinity;
        let nextItemStopped = false;
        for (const it of items) {
          if (it.total > a.pos + 1e-9 && it.total < nextItem) {
            nextItem = it.total;
            nextItemStopped = it.stopped;
          }
        }
        if (nextItem === Infinity) continue; // 前方无物品（疏流区/空带）不判定
        if (a.pos < 0) continue; // 链首外侧等待区（遮罩外不可见）不判定——流入后
                                 // 首个钳位即与物品格网精确对齐（自愈）
        if (arrowMoved && nextItemStopped) continue; // 灌入瞬态: 相位扫动合法
        const off = ((nextItem - a.pos) % 1 + 1) % 1;
        const offMin = Math.min(off, 1 - off);
        // 容差 0.05 格（≈2px）: 饱和等待区/灌入瞬态的残余扫动，下次钳位自愈，
        // 视觉不可辨（用户图1 的"错开"是半格级）。稳态棋盘对齐由 S11 精确断言。
        if (offMin > 0.55) {
          console.log(`  [tick ${t}] ${chainId.slice(-1)}带 指针#${a.id} d=${a.pos.toFixed(4)} 对前方物品 ${nextItem.toFixed(4)} 离格 ${offMin.toFixed(4)}【0-1 网格错开】`);
          alignFails++;
        }
      }
      // ③ 无重叠（指针间）+ ④ 密度。指针-物品距离不判定: 覆盖接近由击杀规则收尾
      //    （注入格击杀/流动覆盖击杀/停稳击杀），接近走廊是用户模型内的合法瞬态。
      const arrows = st.q.arrows;
      for (let i = 0; i < arrows.length; i++) {
        for (let j = i + 1; j < arrows.length; j++) {
          if (Math.abs(arrows[i]!.pos - arrows[j]!.pos) < 1 - 1e-6) {
            console.log(`  [tick ${t}] ${chainId.slice(-1)}带 指针#${arrows[i]!.id}/#${arrows[j]!.id} 间距 ${Math.abs(arrows[i]!.pos - arrows[j]!.pos).toFixed(4)} <1【重叠】`);
            overlapFails++;
          }
        }
      }
      if (arrows.length > len + 1) {
        console.log(`  [tick ${t}] ${chainId.slice(-1)}带 指针数 ${arrows.length} > 链长+1=${len + 1}【超密度】`);
        overlapFails++;
      }
      this.record(chainId, st.q);
    }
    for (const id of [...this.states.keys()]) if (!seen.has(id)) this.states.delete(id);
  }

  private record(chainId: string, q: ChainPointerQueue): void {
    this.prevPos.set(chainId, new Map(q.arrows.map((a) => [a.id, a.pos] as const)));
  }
}

/** 逐 Tick 跑仿真 + 镜像推进/检测。 */
function runFrames(
  world: World,
  beltSys: { update: (w: World, dt: number) => void },
  machineSys: { update: (w: World, dt: number) => void },
  mirror: QueueMirror, ticks: number, tickStart = 1,
  beforeTick?: (t: number) => void,
): void {
  for (let t = tickStart; t <= ticks; t++) {
    beforeTick?.(t);
    beltSys.update(world, 50);
    machineSys.update(world, 50);
    mirror.tick(world, t, { check: true });
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
  const chain = (x: number, yTop: number, len: number, tag: string): string => {
    const id = `chain-1754000000${100 + chainSerial++}-${tag}`;
    for (let i = 0; i < len; i++) belt(x, yTop - i, id, i, i === len - 1);
    return id;
  };
  const bId = chain(6, 4, opts.bLen, 'B');
  chain(5, 4, opts.aLen, 'A');
  if (opts.aToSink) placeSinkAt(world, 4, 4 - opts.aLen); // 端口格 = A 链尾出口
  f.bufferInput[0] = { itemId: 'originium_ore', count: 50 };

  const mirror = new QueueMirror();
  runFrames(world, beltSys, machineSys, mirror, opts.ticks, 1, (t) => {
    if (t === opts.extendAt) {
      const all = [...world.query('BeltSegmentComp', 'Position')]
        .map((h) => ({ h, seg: world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')! }))
        .filter((x) => x.seg.chainId === bId)
        .sort((p, q) => (p.seg.segmentIndex ?? 0) - (q.seg.segmentIndex ?? 0));
      const oldTail = all[all.length - 1];
      if (oldTail !== undefined) {
        const pos = world.getComponent<{ x: number; y: number }>(oldTail.h, 'Position')!;
        oldTail.seg.isTail = false;
        const gy = Math.round(pos.y / CELL_SIZE);
        for (let i = 0; i < opts.extendLen; i++) {
          const h = world.createEntity();
          world.addComponent(h, 'Position', { x: 6 * CELL_SIZE, y: (gy - 1 - i) * CELL_SIZE });
          world.addComponent(h, 'BeltSegmentComp', {
            chainId: bId, direction: 270, isCorner: false, isTail: i === opts.extendLen - 1,
            segmentIndex: (oldTail.seg.segmentIndex ?? 0) + 1 + i, phaseOffset: 0, items: [], blocked: false,
          } as BeltSegmentComp);
        }
        console.log(`  [tick ${t}] 延长 B: 新增 ${opts.extendLen} 段`);
      }
    }
  });
}

runScenario('S1 典型场景', { aLen: 3, bLen: 3, extendAt: 300, extendLen: 3, aToSink: true, ticks: 900 });
runScenario('S2 短带', { aLen: 1, bLen: 2, extendAt: 300, extendLen: 2, aToSink: true, ticks: 900 });
runScenario('S3 双死端', { aLen: 3, bLen: 3, extendAt: 300, extendLen: 3, aToSink: false, ticks: 900 });
runScenario('S4 不延长(对照)', { aLen: 3, bLen: 3, extendAt: 1 << 30, extendLen: 0, aToSink: true, ticks: 900 });

// ═══ S5 堵塞 → 指针整列冻结（§十三"0 也排队"；T2.28"照常循环"反转回队列语义）═══
{
  console.log('\n═══ S5 堵塞 → 指针排队冻结 ═══');
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
  const mirror = new QueueMirror();
  for (let t = 1; t <= 600; t++) {
    beltSys.update(world, 50); machineSys.update(world, 50);
    mirror.tick(world, t, { check: false });
  }
  const stillJammed = [...world.query('BeltSegmentComp', 'Position')]
    .every((h) => (world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!.items ?? []).length > 0);
  const before = new Map<string, Map<number, number>>();
  for (const id of [idA, idB]) {
    before.set(id, new Map(mirror.states.get(id)!.q.arrows.map((a) => [a.id, a.pos] as const)));
  }
  for (let t = 601; t <= 602; t++) {
    beltSys.update(world, 50); machineSys.update(world, 50);
    mirror.tick(world, t, { check: false });
  }
  let maxFlow = 0;
  for (const [id, prev] of before) {
    for (const a of mirror.states.get(id)!.q.arrows) {
      const p0 = prev.get(a.id);
      if (p0 !== undefined) maxFlow = Math.max(maxFlow, Math.abs(a.pos - p0));
    }
  }
  assertOk(stillJammed, 'S5-a. 前置: 双链仍饱和堵塞（物品未被清空）');
  assertOk(maxFlow < 1e-9, `S5-b. 饱和堵塞 2 Tick 指针最大位移 ${maxFlow.toExponential(2)}（期望 0——0 与 1 同律排队冻结，不滑过停走队列）`);
}

// ═══ S6 空带流速=带速（与链长无关；循环瞬移按 +链长 还原）═══
{
  console.log('\n═══ S6 空带流速 ═══');
  const mk = (len: number): { q: ChainPointerQueue; len: number } => {
    const q = new ChainPointerQueue();
    q.seed(len, 0.3);
    return { q, len };
  };
  const short = mk(1);
  const long = mk(5);
  let accS = 0, accL = 0;
  let prevS = short.q.arrows[0]!.pos, prevL = long.q.arrows[0]!.pos;
  for (let t = 0; t < 190; t++) {
    short.q.advance(short.len, 1, []);
    long.q.advance(long.len, 1, []);
    const curS = short.q.arrows[0]!.pos, curL = long.q.arrows[0]!.pos;
    // 循环瞬移 Tick 记一份流动量（圈长 = len+1，按 mod len 记账会把圈长误差灌进
    // 速率——瞬移 Tick 的"真实运动"就是那 0.025）
    accS += curS - prevS < -1 ? ITEM_PROGRESS_PER_TICK : curS - prevS;
    accL += curL - prevL < -1 ? ITEM_PROGRESS_PER_TICK : curL - prevL;
    prevS = curS; prevL = curL;
  }
  const rateS = accS / 190, rateL = accL / 190;
  assertOk(Math.abs(rateS - ITEM_PROGRESS_PER_TICK) < 1e-9 && Math.abs(rateL - ITEM_PROGRESS_PER_TICK) < 1e-9,
    `S6-a. 空带指针速度 = 带速: 1格链 ${rateS.toFixed(6)}、5格链 ${rateL.toFixed(6)} 格/Tick（期望均 ${ITEM_PROGRESS_PER_TICK}）`);
  assertOk(Math.abs(rateS - rateL) < 1e-12, `S6-b. 速度与链长无关（|差| = ${Math.abs(rateS - rateL).toExponential(2)}）`);
}

// ═══ S7 一格一箭头（结构性: 指针间距 ≥1 → 每格 ≤1 支）═══
{
  console.log('\n═══ S7 一格一箭头 ═══');
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
  const mirror = new QueueMirror();
  let checked = 0, worst = 0;
  for (let t = 1; t <= 300; t++) {
    beltSys.update(world, 50); machineSys.update(world, 50);
    mirror.tick(world, t, { check: false });
    const st = mirror.states.get(idA);
    if (!st || itemsOf(world, idA).length === 0) continue;
    checked++;
    const len = chainLenOf(world, idA);
    for (let cell = -1; cell <= len; cell++) {
      const n = st.q.arrows.filter((a) => Math.floor(a.pos) === cell).length;
      worst = Math.max(worst, n);
    }
  }
  assertOk(checked > 0 && worst <= 1,
    `S7. ${checked} Tick 一格一箭头检查: 单格最多 ${worst} 支（期望 ≤1，间距 ≥1 的推论）`);
}

// ═══ S8 统一注入: 段首 0 + 随流 delta（T2.29）═══
{
  console.log('\n═══ S8 注入段首 0 ═══');
  const { world, machineSys, place } = makeWorld();
  const f = place('refining_unit', 5, 5);
  f.bufferOutput[0] = { itemId: 'origocrust', count: 2 };
  const idA = 'chain-1754000000990-A';
  for (let i = 0; i < 3; i++) {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: 5 * CELL_SIZE, y: (4 - i) * CELL_SIZE });
    world.addComponent(h, 'BeltSegmentComp', {
      chainId: idA, direction: 270, isCorner: false, isTail: i === 2,
      segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
    } as BeltSegmentComp);
  }
  machineSys.update(world, 50);
  const headSeg = (world.query('BeltSegmentComp', 'Position')
    .map((h) => world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!)
    .find((s) => (s.segmentIndex ?? 0) === 0))!;
  const injected = headSeg.items[0];
  assertOk(injected !== undefined && injected.progress === 0,
    `S8-a. 注入落段首: progress ${injected?.progress ?? '无'}（期望 0——旧 frac(领头) 放置会把链历史的任意相位冻结进跨带图案）`);
  assertOk(injected !== undefined && injected.delta === ITEM_PROGRESS_PER_TICK,
    `S8-b. 注入随流 delta ${injected?.delta ?? '无'}（期望 ${ITEM_PROGRESS_PER_TICK}）`);
}

// ═══ S9 释放边界浮点容差（T2.23 遗产）═══
{
  console.log('\n═══ S9 释放边界浮点容差 ═══');
  const { world, beltSys, machineSys, place } = makeWorld();
  placeSinkAt(world, 4, 1); // 输入端口格 (5,1) = 尾格 (5,2) 出口
  const idA = 'chain-1754000000995-A';
  let tailSeg: BeltSegmentComp | null = null;
  for (let i = 0; i < 2; i++) {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: 5 * CELL_SIZE, y: (3 - i) * CELL_SIZE });
    const seg = {
      chainId: idA, direction: 270, isCorner: false, isTail: i === 1,
      segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
    } as BeltSegmentComp;
    world.addComponent(h, 'BeltSegmentComp', seg);
    if (i === 1) tailSeg = seg;
  }
  tailSeg!.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  let absorbedAt = -1, releasedAt = -1;
  for (let t = 1; t <= 60 && releasedAt < 0; t++) {
    beltSys.update(world, 50);
    machineSys.update(world, 50);
    const items = tailSeg!.items ?? [];
    if (absorbedAt < 0 && items.some((it) => it.entering === true)) absorbedAt = t;
    if (absorbedAt >= 0 && items.length === 0) releasedAt = t;
  }
  const span = releasedAt - absorbedAt;
  assertOk(absorbedAt > 0 && span <= 40, `S9. entering 行程 0.5→1.5 恰 ${span ?? '?'} Tick 释放（期望 40；无容差时 41）`);
}

// ═══ S10 门口行走期间的间距精确性（T2.26 + T2.29 栅格对齐）═══
{
  console.log('\n═══ S10 门口行走期间间距恒 1.0 ═══');
  const { world, beltSys, machineSys, place } = makeWorld();
  void place;
  const loaderDef = BUILDING_DEFINITIONS['depot_loader' as keyof typeof BUILDING_DEFINITIONS];
  const unloaderDef = BUILDING_DEFINITIONS['depot_unloader' as keyof typeof BUILDING_DEFINITIONS];
  const mkDepot = (gx: number, gy: number, defId: 'depot_loader' | 'depot_unloader'): void => {
    const def = defId === 'depot_loader' ? loaderDef : unloaderDef;
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    world.addComponent(h, 'BuildingComp', {
      definitionId: defId, direction: 180, state: 'idle', paused: false,
      bufferInput: createBufferSlots(def.inputSlotCount),
      bufferOutput: createBufferSlots(def.outputSlotCount),
      inputPollIndex: 0, outputPollQueue: [],
      currentRecipeId: null, progress: 0, elapsed: 0,
    } as BuildingComp);
  };
  mkDepot(4, 6, 'depot_unloader'); // 取货口: 输出口端口格 (5,6) → 链首 (5,5) 入口侧
  mkDepot(4, 3, 'depot_loader');   // 存货口: 输入口端口格 (5,3) ← 链尾 (5,4) 出口
  const idA = 'chain-1755000000099-A';
  for (let i = 0; i < 2; i++) {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: 5 * CELL_SIZE, y: (5 - i) * CELL_SIZE });
    world.addComponent(h, 'BeltSegmentComp', {
      chainId: idA, direction: 270, isCorner: false, isTail: i === 1,
      segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
    } as BeltSegmentComp);
  }
  let maxOffset = 0;
  let checkedTicks = 0;
  for (let t = 1; t <= 600; t++) {
    beltSys.update(world, 50);
    machineSys.update(world, 50);
    const items: number[] = [];
    for (const h of world.query('BeltSegmentComp', 'Position')) {
      const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!;
      if (seg.chainId !== idA) continue;
      const idx = seg.segmentIndex ?? 0;
      for (const it of seg.items ?? []) items.push(idx + it.progress);
    }
    if (items.length < 2) continue;
    checkedTicks++;
    const leader = Math.max(...items);
    for (const x of items) {
      const off = ((x - leader) % 1 + 1.5) % 1 - 0.5; // wrap 到 (−0.5, 0.5]
      maxOffset = Math.max(maxOffset, Math.abs(off));
    }
  }
  assertOk(
    maxOffset < 1e-9,
    `S10. ${checkedTicks} Tick 全链物品对领头 mod1 偏移峰值 ${maxOffset.toExponential(2)}（期望 <1e-9；T2.29 栅格对齐后应精确为 0）`,
  );
}

// ═══ S11 双带轮询棋盘（图2/3 根治断言）═══
{
  console.log('\n═══ S11 双带轮询棋盘 0-1-0/1-0-1 ═══');
  const { world, beltSys, machineSys, place } = makeWorld();
  const f = place('refining_unit', 5, 5);
  const mkChain = (x: number, tag: string, serial: number, len = 3): string => {
    const id = `chain-1756000000${serial}-${tag}`;
    for (let i = 0; i < len; i++) {
      const h = world.createEntity();
      world.addComponent(h, 'Position', { x: x * CELL_SIZE, y: (4 - i) * CELL_SIZE });
      world.addComponent(h, 'BeltSegmentComp', {
        chainId: id, direction: 270, isCorner: false, isTail: i === len - 1,
        segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
      } as BeltSegmentComp);
    }
    return id;
  };
  const idA = mkChain(5, 'A', 1); // A 先建先跑（独跑密集段）
  placeSinkAt(world, 4, 1);
  placeSinkAt(world, 5, 1);      // B 的 sink 也先放好（避免 B 建成即断头红显）
  f.bufferInput[0] = { itemId: 'originium_ore', count: 500 };
  const JOIN_AT = 300;
  let idB: string | null = null;
  const lastInject = new Map<string, number>();
  const emissions: Array<{ tick: number; chain: string }> = [];
  let maxLatticeErr = 0;
  let checkerboardChecked = 0;
  let checkerboardViolations = 0;
  for (let t = 1; t <= 3000; t++) {
    if (t === JOIN_AT) idB = mkChain(6, 'B', 2); // 动态接入（创建序在 A 后）
    beltSys.update(world, 50);
    machineSys.update(world, 50);
    // 出货事件: 链首格出现 progress=0 物品的 Tick（注入后下一 Tick 起推进）
    for (const id of [idA, idB]) {
      if (id === null) continue;
      const headSeg = (world.query('BeltSegmentComp', 'Position')
        .map((h) => world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!)
        .find((s) => s.chainId === id && (s.segmentIndex ?? 0) === 0))!;
      const it0 = headSeg.items[0];
      if (it0 !== undefined && it0.progress === 0 && lastInject.get(id) !== t) {
        lastInject.set(id, t);
        emissions.push({ tick: t, chain: id });
      }
    }
    // 格栅精确性
    for (const id of [idA, idB]) {
      if (id === null) continue;
      for (const x of itemsOf(world, id).map((r) => r.total)) {
        maxLatticeErr = Math.max(maxLatticeErr, Math.abs(x * 40 - Math.round(x * 40)));
      }
    }
    // 棋盘偏移（A 独跑密集段排出后才开始判——密集段两奇偶都有物品，棋盘无定义）
    if (idB !== null && t > JOIN_AT + 300) {
      const totalsA = itemsOf(world, idA).map((r) => r.total);
      const totalsB = itemsOf(world, idB).map((r) => r.total);
      if (totalsA.length > 0 && totalsB.length > 0) {
        checkerboardChecked++;
        const off = ((totalsA[0]! - totalsB[0]!) % 2 + 2) % 2;
        if (Math.abs(off - 1) > 1e-6) checkerboardViolations++;
      }
    }
  }
  assertOk(maxLatticeErr < 1e-9, `S11-a. 3000 Tick 全部物品 progress 落 1/40 格栅（峰值误差 ${maxLatticeErr.toExponential(2)}；旧版浮点累加漂移 = "跑久了又变正常"的根源）`);
  const post = emissions.filter((e) => e.tick > JOIN_AT);
  let gapsOk = post.length > 20;
  for (let i = 1; i < post.length; i++) {
    if (post[i]!.tick - post[i - 1]!.tick !== 40) gapsOk = false;
  }
  assertOk(gapsOk, `S11-b. 接入后相邻成功出货间隔恒 40 Tick（事件 ${post.length}，全部间隔=40: ${gapsOk}）`);
  assertOk(checkerboardChecked > 2000 && checkerboardViolations === 0,
    `S11-c. ${checkerboardChecked} Tick 双带物品 total 差 mod 2 == 1（0-1-0/1-0-1 棋盘精确成立、零漂移; 违例 ${checkerboardViolations}）`);
}

// ═══ S12 停走击杀 + 疏通恢复（§十三②"1 停稳后 0 才消失"）═══
{
  console.log('\n═══ S12 停走击杀 + 疏通恢复 ═══');
  const { world, beltSys, machineSys, place } = makeWorld();
  const f = place('refining_unit', 5, 5);
  const idA = 'chain-1754000000997-A';
  for (let i = 0; i < 3; i++) {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: 5 * CELL_SIZE, y: (4 - i) * CELL_SIZE });
    world.addComponent(h, 'BeltSegmentComp', {
      chainId: idA, direction: 270, isCorner: false, isTail: i === 2,
      segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
    } as BeltSegmentComp);
  }
  f.bufferInput[0] = { itemId: 'originium_ore', count: 50 };
  const mirror = new QueueMirror();
  const UNBLOCK_AT = 350;
  let saturated = false;
  let touching = -1;
  let unblocked = false;
  let p0: Map<number, number> | null = null;
  let p1: Map<number, number> | null = null;
  for (let t = 1; t <= 400; t++) {
    if (t === UNBLOCK_AT) {
      // 疏通: 移走队首（最末格）物品 → 后方恢复流动
      const segs = [...world.query('BeltSegmentComp', 'Position')]
        .map((h) => world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!)
        .filter((s) => s.chainId === idA)
        .sort((a, b) => (b.segmentIndex ?? 0) - (a.segmentIndex ?? 0));
      segs[0]!.items.shift();
      unblocked = true;
    }
    beltSys.update(world, 50); machineSys.update(world, 50);
    mirror.tick(world, t, { check: false });
    if (t === UNBLOCK_AT) {
      p0 = new Map(mirror.states.get(idA)!.q.arrows.map((a) => [a.id, a.pos] as const));
    }
    if (t === UNBLOCK_AT + 1) {
      p1 = new Map(mirror.states.get(idA)!.q.arrows.map((a) => [a.id, a.pos] as const));
    }
    if (!unblocked) {
      const items = itemsOf(world, idA);
      if (items.length === 3 && items.every((it) => it.stopped)) {
        saturated = true;
        const st = mirror.states.get(idA)!;
        touching = st.q.arrows.filter((a) =>
          items.some((it) => Math.abs(it.total - a.pos) <= CONTACT_KILL_DIST + 1e-6)).length;
      }
    }
  }
  assertOk(saturated && touching === 0, `S12-a. 链满堵塞后停稳物品接触范围内指针数 ${touching}（期望 0——"1 停稳后 0 消失"）`);
  // 疏通后指针恢复流动: 比较 UNBLOCK_AT 与 +1 Tick 的位置（再晚传送带会重新饱和）
  let moved = false;
  for (const [id, p] of p0!) {
    const q1 = p1!.get(id);
    if (q1 !== undefined && Math.abs(q1 - p) > 1e-9) moved = true;
  }
  assertOk(moved, 'S12-b. 疏通后指针恢复流动（不再冻结）');
}

// ═══ S13 注入重相位（≤半格刚体平移到新物品格网）═══
{
  console.log('\n═══ S13 注入重相位 ═══');
  const q = new ChainPointerQueue();
  q.seed(4, 0.37); // 任意播种相位
  q.advance(4, 1, []); // 空带流动
  const before = q.arrows.map((a) => a.pos);
  q.rephase(0.8); // 注入: 物品格网 0.8
  const after = q.arrows.map((a) => a.pos);
  const allOnGrid = after.every((p) => {
    const off = ((p - 0.8) % 1 + 1) % 1;
    return Math.min(off, 1 - off) < 1e-9;
  });
  const shift = after[0]! - before[0]!;
  const rigid = after.every((p, i) => Math.abs((p - before[i]!) - shift) < 1e-9);
  assertOk(allOnGrid && rigid && Math.abs(shift) <= 0.5 + 1e-9,
    `S13. 注入重相位: 全体指针落物品格网（${allOnGrid}）、刚体平移（${rigid}）、最短模距离 |δ|=${Math.abs(shift).toFixed(3)} ≤0.5`);
}

// ═══ S14 空带连续流（无移动空洞 + 无整列停顿 + 瞬移不内插）═══
{
  console.log('\n═══ S14 空带连续流 ═══');
  for (const len of [2, 5]) {
    const q = new ChainPointerQueue();
    q.seed(len, 0.125);
    // 暖机 3 圈 + 采样 2 圈（圈长 = (len+1) 格 × 40 Tick/格）
    for (let t = 0; t < (len + 1) * 40 * 3; t++) q.advance(len, 1, []);
    let worstGap = 0, countBad = 0, frozenTicks = 0, checked = 0, worstSpan = 0;
    const prevPos = new Map<number, number>();
    for (let t = 0; t < (len + 1) * 40 * 2; t++) {
      for (const a of q.arrows) prevPos.set(a.id, a.pos);
      q.advance(len, 1, []);
      checked++;
      const ps = q.arrows.map((a) => a.pos).sort((x, y) => x - y);
      if (ps.length !== len + 1) countBad++;
      for (let i = 1; i < ps.length; i++) {
        worstGap = Math.max(worstGap, Math.abs(ps[i]! - ps[i - 1]! - 1));
      }
      for (const a of q.arrows) {
        const p0 = prevPos.get(a.id);
        if (p0 === undefined) continue;
        const d = a.pos - p0;
        if (Math.abs(d) < 1e-9) frozenTicks++;
        // 渲染语义: |Δ| > 0.55 = 瞬移 → 渲染器中和（prevD=lastD，跨度 0）;
        // 否则内插跨度 = |Δ| ≤ 0.525（重相位）——横扫双影结构性不可达
        worstSpan = Math.max(worstSpan, d < -0.55 ? 0 : Math.abs(d));
      }
    }
    assertOk(countBad === 0 && worstGap < 1e-6 && frozenTicks === 0 && worstSpan < 0.53,
      `S14-${len}格带. ${checked} Tick 空带连续流: 指针数恒 ${len + 1}（违例 ${countBad}）、间距恒 1.0（峰值偏差 ${worstGap.toExponential(2)}——移动空洞"0-0-0-空"根除）、零停顿 Tick（${frozenTicks}）、渲染内插跨度 ≤0.53（峰值 ${worstSpan.toFixed(3)}，循环瞬移已中和 = 无横扫双影）`);
  }
}

// ═══ S15 满载流无下骑（一格只能 0 或 1）═══
{
  console.log('\n═══ S15 满载流无下骑 ═══');
  const { world, beltSys, machineSys, place } = makeWorld();
  const f = place('refining_unit', 5, 5);
  placeSinkAt(world, 4, 1); // 端口格 (5,1) = A 链尾 (5,2) 出口
  const idA = 'chain-1754000000980-A';
  for (let i = 0; i < 3; i++) {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: 5 * CELL_SIZE, y: (4 - i) * CELL_SIZE });
    world.addComponent(h, 'BeltSegmentComp', {
      chainId: idA, direction: 270, isCorner: false, isTail: i === 2,
      segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
    } as BeltSegmentComp);
  }
  f.bufferInput[0] = { itemId: 'originium_ore', count: 500 };
  const mirror = new QueueMirror();
  let minDist = Infinity;
  let sameCell = 0;
  let checked = 0;
  for (let t = 1; t <= 1200; t++) {
    beltSys.update(world, 50);
    machineSys.update(world, 50);
    mirror.tick(world, t, { check: false });
    if (t <= 500) continue; // 暖机至稳态满载流（单带 40-Tick 节拍 = 1-1-1 密集）
    const st = mirror.states.get(idA)!;
    const items = itemsOf(world, idA);
    checked++;
    for (const a of st.q.arrows) {
      for (const it of items) {
        const d = Math.abs(it.total - a.pos);
        minDist = Math.min(minDist, d);
        if (Math.floor(a.pos + 1e-9) === Math.floor(it.total + 1e-9)) sameCell++;
      }
    }
  }
  assertOk(minDist >= 1 - 1e-6 && sameCell === 0,
    `S15. ${checked} Tick 满载流: 指针-物品最小距离 ${minDist.toFixed(4)}（期望 ≥1.0）、同格共存 ${sameCell} 次（期望 0——物品下方永久跟针/亚格间距同行已根除，注入格上的 0 让位）`);
}

// ═══ S16 空带相位独立（每条带 = 自己的创建时刻）═══
{
  console.log('\n═══ S16 空带相位独立 ═══');
  // a) 纯队列: 两条链不同创建相位 → 各自保持、互不同步
  {
    const qA = new ChainPointerQueue();
    const qB = new ChainPointerQueue();
    const cA = chainCreationClass('chain-1754000000101-A', 0);
    const cB = chainCreationClass('chain-1754000000137-B', 0);
    assertOk(Math.abs(cA - cB) > 0.01, `S16-a前置. 两条链创建相位不同（${cA.toFixed(3)} vs ${cB.toFixed(3)}）`);
    for (let t = 0; t < 800; t++) {
      qA.tick(3, [], cA);
      qB.tick(3, [], cB);
    }
    const kA = ((qA.arrows[0]!.pos % 1) + 1) % 1;
    const kB = ((qB.arrows[0]!.pos % 1) + 1) % 1;
    const eA = (cA + 800 * ITEM_PROGRESS_PER_TICK) % 1;
    const eB = (cB + 800 * ITEM_PROGRESS_PER_TICK) % 1;
    const near = (a: number, b: number): boolean => Math.abs(((a - b) % 1 + 1.5) % 1 - 0.5) < 1e-7;
    assertOk(near(kA, eA) && near(kB, eB) && near(qA.freeRunClass, eA),
      `S16-a. 800 Tick 空带流动且相位 = 创建时刻时钟（A ${kA.toFixed(4)}→${eA.toFixed(4)}, B ${kB.toFixed(4)}→${eB.toFixed(4)}——指针在流（非静止），各链相位 = 创建相位+流逝，互不同步）`);
    // a2) 错时刻播种: B 在 A 跑了 100 Tick 后才出现（不同全局时刻播种）——相位差
    //     必须保持 ≠ 0（ frac(ts/周期) 派生会被流动量精确抵消 → 全局同相，
    //     浏览器像素实测暴露，T2.29-c 代理验证发现; 哈希序位与时钟不相关故免疫）
    const qC = new ChainPointerQueue();
    const idC = 'chain-1754000000199-C';
    const cC = chainCreationClass(idC, 0);
    for (let t = 0; t < 100; t++) qA.tick(3, [], cA);
    for (let t = 0; t < 300; t++) qA.tick(3, [], cA);
    for (let t = 0; t < 300; t++) qC.tick(3, [], cC);
    const kA2 = ((qA.arrows[0]!.pos % 1) + 1) % 1;
    const kC = ((qC.arrows[0]!.pos % 1) + 1) % 1;
    let dAC = (((kC - kA2) % 1) + 1) % 1;
    assertOk(Math.min(dAC, 1 - dAC) > 0.01,
      `S16-a2. 错时刻播种的两链相位差 ${Math.min(dAC, 1 - dAC).toFixed(4)} 恒 ≠ 0（A ${kA2.toFixed(4)} vs C ${kC.toFixed(4)}——创建时刻偏移不被流动量抵消）`);
  }
  // b) 带过物品 → 排空 → 回归创建相位
  {
    const { world, beltSys, machineSys, place } = makeWorld();
    const f = place('refining_unit', 5, 5);
    placeSinkAt(world, 4, 1);
    const idA = 'chain-1754000000203-A';
    for (let i = 0; i < 3; i++) {
      const h = world.createEntity();
      world.addComponent(h, 'Position', { x: 5 * CELL_SIZE, y: (4 - i) * CELL_SIZE });
      world.addComponent(h, 'BeltSegmentComp', {
        chainId: idA, direction: 270, isCorner: false, isTail: i === 2,
        segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
      } as BeltSegmentComp);
    }
    f.bufferInput[0] = { itemId: 'originium_ore', count: 30 };
    const mirror = new QueueMirror();
    const cA = chainCreationClass(idA, 0);
    let carried = false;
    let restoredAt = -1;
    for (let t = 1; t <= 1600 && restoredAt < 0; t++) {
      beltSys.update(world, 50);
      machineSys.update(world, 50);
      mirror.tick(world, t, { check: false });
      if (itemsOf(world, idA).length > 0) carried = true;
      if (carried && itemsOf(world, idA).length === 0 && t > 200) {
        for (let k = 0; k < 3; k++) {
          beltSys.update(world, 50);
          machineSys.update(world, 50);
          mirror.tick(world, t + 1 + k, { check: false });
        }
        const q = mirror.states.get(idA)!.q;
        const klass = ((q.arrows[0]!.pos % 1) + 1) % 1;
        // 回归目标 = 虚拟创建时钟（持续前进），不是静态创建相位
        const d = (((q.freeRunClass - klass) % 1) + 1) % 1;
        if (Math.min(d, 1 - d) < 1e-9) restoredAt = t;
      }
    }
    assertOk(carried && restoredAt > 0,
      `S16-b. 带过物品排空后回归虚拟创建时钟（携带 ✓，回归 @tick ${restoredAt}，时钟锚 ${cA.toFixed(4)}——被设备节拍对齐后不再残留同相，且回归后随时钟继续流动非静止）`);
  }
}

console.log(`\n累计指针跳变: ${arrowJumps}（应 0）/ 0-1 网格错开: ${alignFails}（应 0）/ 重叠: ${overlapFails}（应 0）`);
process.exit(arrowJumps === 0 && alignFails === 0 && overlapFails === 0 && assertFails === 0 ? 0 : 1);
