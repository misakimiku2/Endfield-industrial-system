// T2.29-c 扩展压测 — 运行: node --experimental-strip-types scripts/_stress-t29c.ts
//
// 纯 node 脚本（不 import pixi）。参考 diagnose-pointer-flicker.ts 的
// makeWorld/place/placeSinkAt/itemsOf 与 ChainPointerQueue/chainCreationClass 用法。
// 针对三项修复的扩展断言（全部计数器收集，最后汇总，违例应全 0）:
//
//   组1 取货口场景全相位扫描（25 档 × 600 Tick，真实 BeltSystem+MachineSystem）:
//     depot_unloader(4,10,180°) + 8 格链（(5,9) 起向上，direction 270，参考 S10 搭法）。
//     chainCreationClass = chainId 哈希（T2.29-c 后）→ 暴力搜索命中目标相位的
//     chainId，覆盖 phase ∈ {0.02, 0.06, ..., 0.98}。每 Tick q.tick(len, items, chainCreationClass(id,0))。
//     断言全程:
//       (a) 前导空格 = 0: 不存在"领头物品前方一格既无物品也无指针"的 Tick
//           （正确布局 IIAAAAAA——物品后紧跟指针填满；错误布局 I.AAAAA）;
//       (b) 注入 Tick 被杀的指针中，被杀前一 Tick 位置 ≥ −0.02（带内可见）的次数 = 0
//           （注入击杀必须发生在物品身下不可见处，pos<0 为遮罩外等待区）。
//
//   组2 空带流动与互不同步: 3 条 5 格链、时间戳相差 700ms，各跑 400 Tick 空转:
//       (a) 每链每 Tick 全体指针位移恰 0.025（循环瞬移 Tick 除外，其位移 ≤ −链长）;
//       (b) 三链相位两两差恒定 ≠ 0（mod 1）——各带图案从各自创建时刻起跑。
//
//   组3 排空回归: 精炼炉 + 3 格链 + 存货口，喂 30 矿跑至物品流过、输入耗尽排空后:
//       (a) 空带恢复流动（每 Tick 位移 0.025，循环瞬移 ≤ −链长除外，零静止 Tick）;
//       (b) 相位 == q.freeRunClass（±1e-9）——回归虚拟创建时钟。

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
import { ChainPointerQueue, chainCreationClass, type QueueItemRef } from '../src/game/render/BeltPointerQueue.ts';
import type { BuildingComp } from '../src/game/components/BuildingComp.ts';
import type { BeltSegmentComp } from '../src/game/components/BeltSegmentComp.ts';
import { CELL_SIZE } from '../src/game/render/constants.ts';

// ── 数据/注册表（同 diagnose-pointer-flicker.ts）──
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

/** 仓库口（depot_unloader/depot_loader, 180°），端口格 = (gx+1, gy)。参考 S10 mkDepot。 */
function mkDepot(world: World, gx: number, gy: number, defId: 'depot_unloader' | 'depot_loader'): void {
  const def = BUILDING_DEFINITIONS[defId as keyof typeof BUILDING_DEFINITIONS];
  const h = world.createEntity();
  world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
  world.addComponent(h, 'BuildingComp', {
    definitionId: defId, direction: 180, state: 'idle', paused: false,
    bufferInput: createBufferSlots(def.inputSlotCount),
    bufferOutput: createBufferSlots(def.outputSlotCount),
    inputPollIndex: 0, outputPollQueue: [],
    currentRecipeId: null, progress: 0, elapsed: 0,
  } as BuildingComp);
}

/** 直段链（direction 270 向上，seg0 @ (x, yHead)，向上延伸）。 */
function mkChain(world: World, x: number, yHead: number, len: number, chainId: string): void {
  for (let i = 0; i < len; i++) {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: x * CELL_SIZE, y: (yHead - i) * CELL_SIZE });
    world.addComponent(h, 'BeltSegmentComp', {
      chainId, direction: 270, isCorner: false, isTail: i === len - 1,
      segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
    } as BeltSegmentComp);
  }
}

/** 全链物品快照（链上绝对坐标 + 是否停走；entering 过客不计，同渲染器）。 */
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

const frac = (v: number): number => ((v % 1) + 1) % 1;
/** 模 1 最短距离。 */
const modDist = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % 1 + 1.5) % 1 - 0.5);
  return d;
};

// ── 违例计数器 ──
interface Viol { count: number; samples: string[] }
const mkViol = (): Viol => ({ count: 0, samples: [] });
function note(v: Viol, msg: string): void {
  v.count++;
  if (v.samples.length < 5) v.samples.push(msg);
}
const g1aGap = mkViol();      // 组1a 前导空格
const g1bVisKill = mkViol();  // 组1b 带内可见击杀
const g2aFlow = mkViol();     // 组2a 空带位移 ≠ 0.025
const g2aWrap = mkViol();     // 组2a 循环瞬移位移 > −链长
const g2bPhase = mkViol();    // 组2b 三链相位差不恒定/为 0
const g3aFlow = mkViol();     // 组3a 排空后位移 ≠ 0.025（静止）
const g3aWrap = mkViol();     // 组3a 排空后循环瞬移位移 > −链长
const g3bPhase = mkViol();    // 组3b 排空后相位 ≠ freeRunClass

// 健全性统计（非违例，用于确认断言真的被执行到）
const sanity = {
  phasesRun: 0, g1TicksChecked: 0, g1Injections: 0, g1KillsTotal: 0,
  g1SteadyKillPrevPos: new Set<string>(),
  g2ChainsRun: 0, g2TicksChecked: 0, g2Wraps: 0, g2ArrowsChecked: 0,
  g3Carried: false, g3EmptiedAt: -1, g3InputLeft: -1, g3TicksChecked: 0, g3Wraps: 0,
};

// ═══════════════ 组 1: 取货口场景全相位扫描 ═══════════════
console.log('═══ 组1: 取货口 8 格链 全相位扫描（25 档 × 600 Tick）═══');
{
  const LEN = 8;
  for (let k = 0; k < 25; k++) {
    const phase = 0.02 + 0.04 * k; // 0.02 .. 0.98
    // T2.29-c 之后 chainCreationClass = chainId 哈希 → 暴力搜索命中目标相位的序号
    let chainId = '';
    for (let n = 0; n < 200000; n++) {
      const cand = `chain-1754000000000-P${k}x${n}`;
      if (modDist(chainCreationClass(cand, 0), phase) < 0.01) { chainId = cand; break; }
    }
    if (chainId === '') {
      note(g1aGap, `[构造] phase=${phase} 哈希搜索未命中（构造失败）`);
      continue;
    }
    const cc = chainCreationClass(chainId, 0);
    sanity.phasesRun++;

    const { world, beltSys, machineSys } = makeWorld();
    mkDepot(world, 4, 10, 'depot_unloader'); // 输出口端口格 (5,10) → 链首 (5,9)
    mkChain(world, 5, 9, LEN, chainId);      // (5,9) 起向上 8 格 → (5,2)

    const q = new ChainPointerQueue();
    let prevCount = 0;
    let prevPos = new Map<number, number>();
    for (let t = 1; t <= 600; t++) {
      beltSys.update(world, 50);
      machineSys.update(world, 50);
      const items = itemsOf(world, chainId);
      const len = chainLenOf(world, chainId);
      const inject = items.length > prevCount;
      q.tick(len, items, chainCreationClass(chainId, 0));

      // (b) 注入 Tick 被杀的指针: 被杀前一 Tick 位置 ≥ −0.02（带内可见）→ 违例。
      //     播种当 Tick 即被杀的指针无"前一 Tick 位置"（从未渲染过），不计。
      if (inject) {
        sanity.g1Injections++;
        const alive = new Set(q.arrows.map((a) => a.id));
        for (const [id, p] of prevPos) {
          if (alive.has(id)) continue;
          sanity.g1KillsTotal++;
          if (p >= -0.02) {
            note(g1bVisKill, `[phase ${phase.toFixed(2)} tick ${t}] 指针#${id} 注入 Tick 被杀，被杀前一 Tick 位置 ${p.toFixed(4)} ≥ −0.02（带内可见击杀）`);
          } else {
            sanity.g1SteadyKillPrevPos.add(p.toFixed(4));
          }
        }
      }

      // (a) 前导空格: 领头物品前方一格（floor(leader)+1，在链内）必须有权重
      if (items.length > 0) {
        sanity.g1TicksChecked++;
        let leader = -Infinity;
        for (const it of items) if (it.total > leader) leader = it.total;
        const fc = Math.floor(leader + 1e-6) + 1;
        if (fc <= len - 1) {
          const hasItem = items.some((it) => Math.floor(it.total + 1e-6) === fc);
          const hasArrow = q.arrows.some((a) => Math.floor(a.pos + 1e-6) === fc);
          if (!hasItem && !hasArrow) {
            note(g1aGap, `[phase ${phase.toFixed(2)} tick ${t}] 领头物品 @${leader.toFixed(4)} 前方格 ${fc} 既无物品也无指针（前导空格 I.AAAAA）指针位=[${q.arrows.map((a) => a.pos.toFixed(3)).join(', ')}]`);
          }
        }
      }

      prevPos = new Map(q.arrows.map((a) => [a.id, a.pos] as const));
      prevCount = items.length;
    }
  }
  console.log(`  扫描 ${sanity.phasesRun}/25 档，带头物品 Tick ${sanity.g1TicksChecked}，注入 ${sanity.g1Injections} 次，注入击杀指针 ${sanity.g1KillsTotal} 支（稳态击杀前一位置样本: ${[...sanity.g1SteadyKillPrevPos].slice(0, 4).join(', ')}）`);
  console.log(`  (a) 前导空格违例: ${g1aGap.count}${g1aGap.count ? `\n      ${g1aGap.samples.join('\n      ')}` : ''}`);
  console.log(`  (b) 带内可见击杀违例（被杀前一 Tick 位置 ≥ −0.02）: ${g1bVisKill.count}${g1bVisKill.count ? `\n      ${g1bVisKill.samples.join('\n      ')}` : ''}`);
}

// ═══════════════ 组 2: 空带流动与互不同步 ═══════════════
console.log('\n═══ 组2: 3 条 5 格空链（创建时间戳相差 700ms）各 400 Tick 空转 ═══');
{
  const LEN = 5;
  const TICKS = 400;
  const phaseHist: number[][] = [[], [], []]; // 每链每 Tick 的公共相位 frac(min pos)
  for (let c = 0; c < 3; c++) {
    const ts = Math.round(1e12) + c * 700; // 时间戳相差 700ms
    const chainId = `chain-${ts}-E${c}`;
    const cc = chainCreationClass(chainId, 0);
    const q = new ChainPointerQueue();
    sanity.g2ChainsRun++;
    for (let t = 1; t <= TICKS; t++) {
      const prev = new Map(q.arrows.map((a) => [a.id, a.pos] as const));
      q.tick(LEN, [], cc);
      if (q.arrows.length !== LEN + 1) {
        note(g2aFlow, `[链${c} tick ${t}] 指针数 ${q.arrows.length} ≠ 链长+1=${LEN + 1}`);
      }
      if (prev.size > 0) {
        sanity.g2TicksChecked++;
        for (const a of q.arrows) {
          const p = prev.get(a.id);
          if (p === undefined) {
            note(g2aFlow, `[链${c} tick ${t}] 指针#${a.id} 凭空出现（空带无击杀不应有补充）`);
            continue;
          }
          sanity.g2ArrowsChecked++;
          const d = a.pos - p;
          if (d < -1) {
            // 循环瞬移 Tick: 位移 ≤ −链长
            sanity.g2Wraps++;
            if (d > -LEN + 1e-9) {
              note(g2aWrap, `[链${c} tick ${t}] 指针#${a.id} 循环瞬移位移 ${d.toFixed(4)} > −链长(−${LEN})`);
            }
          } else if (Math.abs(d - ITEM_PROGRESS_PER_TICK) > 1e-9) {
            note(g2aFlow, `[链${c} tick ${t}] 指针#${a.id} 位移 ${d.toExponential(3)} ≠ ${ITEM_PROGRESS_PER_TICK}（静止/异常）`);
          }
        }
      }
      // 公共相位 = 最小 pos 指针的 frac（空带全体指针间距恒 1 → frac 相同）
      let min = Infinity;
      for (const a of q.arrows) if (a.pos < min) min = a.pos;
      phaseHist[c].push(frac(min));
    }
  }
  // 三链相位两两差恒定 ≠ 0（mod 1）
  const pairs: Array<[number, number]> = [[0, 1], [0, 2], [1, 2]];
  for (const [i, j] of pairs) {
    const d0 = modDist(phaseHist[i][0]!, phaseHist[j][0]!);
    if (d0 < 1e-9) {
      note(g2bPhase, `链${i}/链${j} 初始相位差 ${d0.toExponential(2)} ≈ 0（互不同步破坏）`);
      continue;
    }
    for (let t = 1; t < TICKS; t++) {
      const d = modDist(phaseHist[i][t]!, phaseHist[j][t]!);
      if (Math.abs(d - d0) > 1e-9) {
        note(g2bPhase, `[tick ${t}] 链${i}/链${j} 相位差漂移: ${d0.toFixed(6)} → ${d.toFixed(6)}`);
        break;
      }
    }
  }
  const p0 = phaseHist.map((h) => h[0]!.toFixed(4)).join(', ');
  console.log(`  3 链 × ${TICKS} Tick（初始相位 ${p0}），位移样本 ${sanity.g2ArrowsChecked}，循环瞬移 ${sanity.g2Wraps} 次（≈3×${Math.floor(TICKS / ((LEN + 1) * 40)) * (LEN + 1)}）`);
  console.log(`  (a) 空带位移 ≠ 0.025 违例: ${g2aFlow.count}${g2aFlow.count ? `\n      ${g2aFlow.samples.join('\n      ')}` : ''}`);
  console.log(`  (a) 循环瞬移位移 > −链长 违例: ${g2aWrap.count}${g2aWrap.count ? `\n      ${g2aWrap.samples.join('\n      ')}` : ''}`);
  console.log(`  (b) 相位差不恒定/为 0 违例: ${g2bPhase.count}${g2bPhase.count ? `\n      ${g2bPhase.samples.join('\n      ')}` : ''}`);
}

// ═══════════════ 组 3: 排空回归 ═══════════════
console.log('\n═══ 组3: 精炼炉 + 3 格链 + 存货口，喂 30 矿 → 排空后恢复流动/回归创建时钟 ═══');
{
  const LEN = 3;
  const TICKS = 1600;
  const ts = Math.round(1e12 + 0.0615 * 2000); // 任意创建相位
  const chainId = `chain-${ts}-D`;
  const cc = chainCreationClass(chainId, 0);
  const { world, beltSys, machineSys, place } = makeWorld();
  const furnace = place('refining_unit', 5, 5);
  furnace.bufferInput[0] = { itemId: 'originium_ore', count: 30 };
  mkDepot(world, 4, 1, 'depot_loader'); // 输入口端口格 (5,1) ← 链尾 (5,2) 出口
  mkChain(world, 5, 4, LEN, chainId);   // (5,4)..(5,2)

  const q = new ChainPointerQueue();
  let prev = new Map<number, number>();
  let carried = false;
  let emptiedAt = -1;
  for (let t = 1; t <= TICKS; t++) {
    beltSys.update(world, 50);
    machineSys.update(world, 50);
    const items = itemsOf(world, chainId);
    q.tick(LEN, items, chainCreationClass(chainId, 0));

    if (items.length > 0) { carried = true; sanity.g3Carried = true; }
    if (carried && items.length === 0 && emptiedAt < 0 && t > 200) emptiedAt = t;

    if (emptiedAt > 0) {
      // 相位断言从排空 Tick（含重相位回归当 Tick）起: frac(全体指针) == freeRunClass
      for (const a of q.arrows) {
        if (modDist(frac(a.pos), q.freeRunClass) > 1e-9) {
          note(g3bPhase, `[tick ${t}] 指针#${a.id} @${a.pos.toFixed(6)} 相位 ${frac(a.pos).toFixed(9)} ≠ freeRunClass ${q.freeRunClass.toFixed(9)}`);
          break;
        }
      }
      // 位移断言从排空次 Tick 起（排空当 Tick 允许 ≤半格回归平移）
      if (t > emptiedAt) {
        sanity.g3TicksChecked++;
        for (const a of q.arrows) {
          const p = prev.get(a.id);
          if (p === undefined) continue;
          const d = a.pos - p;
          if (d < -1) {
            sanity.g3Wraps++;
            if (d > -LEN + 1e-9) {
              note(g3aWrap, `[tick ${t}] 指针#${a.id} 循环瞬移位移 ${d.toFixed(4)} > −链长(−${LEN})`);
            }
          } else if (Math.abs(d - ITEM_PROGRESS_PER_TICK) > 1e-9) {
            note(g3aFlow, `[tick ${t}] 指针#${a.id} 位移 ${d.toExponential(3)} ≠ ${ITEM_PROGRESS_PER_TICK}（排空后未恢复流动/静止）`);
          }
        }
      }
    }
    prev = new Map(q.arrows.map((a) => [a.id, a.pos] as const));
  }
  sanity.g3InputLeft = furnace.bufferInput[0]?.count ?? -1;
  const inputExhausted = sanity.g3InputLeft === 0;
  console.log(`  携带过物品: ${sanity.g3Carried}，排空 @tick ${emptiedAt > 0 ? emptiedAt : '未'}，输入剩余 ${sanity.g3InputLeft}（耗尽: ${inputExhausted}），排空后核查 ${sanity.g3TicksChecked} Tick，瞬移 ${sanity.g3Wraps} 次`);
  if (!sanity.g3Carried) note(g3aFlow, '前置失败: 30 矿从未有物品上带');
  if (emptiedAt < 0) note(g3aFlow, `前置失败: ${TICKS} Tick 内未排空（输入剩余 ${sanity.g3InputLeft}）`);
  else if (!inputExhausted) note(g3aFlow, `前置失败: 排空但输入未耗尽（剩余 ${sanity.g3InputLeft}）`);
  console.log(`  (a) 排空后位移 ≠ 0.025 违例: ${g3aFlow.count}${g3aFlow.count ? `\n      ${g3aFlow.samples.join('\n      ')}` : ''}`);
  console.log(`  (a) 排空后循环瞬移位移 > −链长 违例: ${g3aWrap.count}${g3aWrap.count ? `\n      ${g3aWrap.samples.join('\n      ')}` : ''}`);
  console.log(`  (b) 排空后相位 ≠ freeRunClass 违例: ${g3bPhase.count}${g3bPhase.count ? `\n      ${g3bPhase.samples.join('\n      ')}` : ''}`);
}

// ═══════════════ 汇总 ═══════════════
const total =
  g1aGap.count + g1bVisKill.count +
  g2aFlow.count + g2aWrap.count + g2bPhase.count +
  g3aFlow.count + g3aWrap.count + g3bPhase.count;
console.log('\n═══ T2.29-c 扩展压测汇总 ═══');
console.log(`  组1 取货口全相位扫描: 前导空格 ${g1aGap.count} / 带内可见击杀 ${g1bVisKill.count}`);
console.log(`  组2 空带流动互不同步: 位移违例 ${g2aFlow.count} / 瞬移越界 ${g2aWrap.count} / 相位违例 ${g2bPhase.count}`);
console.log(`  组3 排空回归: 流动违例 ${g3aFlow.count} / 瞬移越界 ${g3aWrap.count} / 相位违例 ${g3bPhase.count}`);
console.log(`\n${total === 0 ? '✅ 三组断言全部通过（违例全 0）' : `❌ 存在违例: ${total}`}`);
process.exit(total === 0 ? 0 : 1);
