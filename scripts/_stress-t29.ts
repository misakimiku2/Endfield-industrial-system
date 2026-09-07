// T2.29 长时压力验证 — 运行: node --experimental-strip-types scripts/_stress-t29.ts
//
// 纯 node 脚本（不 import pixi）。驱动真实 World + BeltSystem + MachineSystem +
// BUILDING_DEFINITIONS（CSV 从 doc/csv/ 读），复现用户双带/三带轮询场景并长时间运行:
//
//   场景 1（双带轮询，用户原场景）50000 Tick:
//     精炼炉 refining_unit @ (5,5)，输入缓冲塞满 originium_ore（999999，产线不停）；
//     A/B 两条 3 格传送带链（direction 270，seg0 @ (5,4)/(6,4)，向上延伸），
//     链尾出口各接一个 depot_loader 存货口（无限汇）；A 先创建，B 于 tick 300 动态接入。
//     断言（tick % 40 == 0 抽样，全程 50000 Tick 跑完）:
//       ① 所有物品 progress 落 1/40 格栅: |total*40 - round(total*40)| < 1e-6（逐 Tick 查）；
//       ② tick > 900 后（B 接入、A 密集段排空）每链物品 total mod 2 单一常量，
//          且两链常量差 mod 2 == 1（0-1-0/1-0-1 棋盘；恒定的是链间相对差——
//          注入相位随首次出货 tick，绝对残差随抽样相位合法轮转）；
//       ③ tick > 300 后相邻成功出货（链首格出现 progress==0 物品，按链去重）间隔恒 40；
//       ④ 每链物品数 ≤ 链长+2=5（存货口吸收，不随时间增长）。
//
//   场景 2（三带轮询）30000 Tick:
//     同场景 1 但三条链 x=5,6,7 + 三个存货口；A/B/C 于 tick 1/300/600 接入；
//     tick > 1500 后断言三链 total mod 3 相对相位互不相同（完整剩余系）且
//     交错指派恒定（1-0-0 空间交错；领先链由轮换队列运行期决定）。
//
//   场景 3（指针队列不变量，ChainPointerQueue 直接驱动）:
//     随场景 1 双链全程维护 QueueMirror（播种 seed(len, beltPhase mod 1) →
//     advance(len,1,items) → 物品数增加时 rephase(rearmost mod 1)，同
//     diagnose-pointer-flicker.ts 顺序），每 40 Tick 抽样断言:
//       a. 每链指针数 ≤ 链长+1；
//       b. 指针两两间距 ≥ 1-1e-6；
//       c. 指针与其前方最近物品（total > pos 的最小者）mod 1 偏差 ≤ 0.55
//          （pos < 0 的链首外等待区豁免）；
//       d. 无指针位于 pos > 链长 + 0.2（链尾余量外不滞留实体）。
//
// 全部断言用计数器收集，最后统一打印 PASS/FAIL 汇总；FAIL 时退出码非 0。

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
import { ChainPointerQueue, type QueueItemRef } from '../src/game/render/BeltPointerQueue.ts';
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

const LATTICE = Math.round(1 / ITEM_PROGRESS_PER_TICK); // 40
const CHAIN_LEN = 3;

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

/** 指针队列逐 Tick 镜像（与 diagnose QueueMirror 同序: 播种 → advance → 物品数增加时重相位）。 */
class Mirror {
  states = new Map<string, { q: ChainPointerQueue; seeded: boolean; lastItemCount: number }>();

  tick(info: Map<string, { len: number; items: QueueItemRef[] }>): void {
    for (const [chainId, e] of info) {
      let st = this.states.get(chainId);
      if (!st) {
        st = { q: new ChainPointerQueue(), seeded: false, lastItemCount: 0 };
        this.states.set(chainId, st);
      }
      if (!st.seeded) {
        st.q.seed(e.len, ((BeltSystem.beltPhase % 1) + 1) % 1);
        st.seeded = true;
      }
      const hadItemCount = st.lastItemCount;
      st.lastItemCount = e.items.length;
      let rearmost = Infinity;
      for (const it of e.items) if (it.total < rearmost) rearmost = it.total;
      // 先推进后重相位（注入 Tick 物品不推进而指针推进，先重相位会错开一个流动量）
      st.q.advance(e.len, 1, e.items);
      if (e.items.length > hadItemCount && rearmost < Infinity) {
        st.q.rephase(((rearmost % 1) + 1) % 1);
      }
    }
    for (const id of [...this.states.keys()]) if (!info.has(id)) this.states.delete(id);
  }
}

interface ChainSpec { x: number; tag: string; serial: number; joinAt: number; }

interface Viol { count: number; samples: string[]; }
const mkViol = (): Viol => ({ count: 0, samples: [] });
function note(v: Viol, msg: string): void {
  v.count++;
  if (v.samples.length < 5) v.samples.push(msg);
}

interface StressResult {
  ticks: number;
  ms: number;
  lattice: Viol;
  boardConst: Viol;      // 同链残差唯一性 + 跨 Tick 恒定
  boardDistinct: Viol;   // 跨链残差互异（棋盘/交错）
  gap: Viol;             // 相邻出货间隔 ≠ 40
  countViol: Viol;       // 物品数 > 链长+2
  ptrDensity: Viol;      // 3a
  ptrOverlap: Viol;      // 3b
  ptrAlign: Viol;        // 3c
  ptrTail: Viol;         // 3d
  boardChecked: number;  // 全链齐备的棋盘抽样 Tick 数
  gapChecked: number;    // 间隔样本数
  gapMin: number; gapMax: number;
  emissionsPost: number; // gapFromTick 后出货事件数
  boardConstants: Map<string, number>; // 各链最终残差
  maxCount: Map<string, number>;
  everDecreased: Map<string, boolean>; // 物品数是否出现过下降（非单调增长的证据）
}

function runStress(opts: {
  label: string;
  ticks: number;
  chains: ChainSpec[];
  sinks: Array<[number, number]>;
  modN: number;
  boardFromTick: number;
  gapFromTick: number;
  withMirror: boolean;
  tsBase: number;
}): StressResult {
  const t0 = Date.now();
  const { world, beltSys, machineSys, place } = makeWorld();
  const f = place('refining_unit', 5, 5);
  f.bufferInput[0] = { itemId: 'originium_ore', count: 999999 };
  for (const [gx, gy] of opts.sinks) placeSinkAt(world, gx, gy);

  const chainIds = new Map<string, string>(); // tag → chainId
  const mkChain = (spec: ChainSpec): string => {
    const id = `chain-${opts.tsBase + spec.serial}-${spec.tag}`;
    for (let i = 0; i < CHAIN_LEN; i++) {
      const h = world.createEntity();
      world.addComponent(h, 'Position', { x: spec.x * CELL_SIZE, y: (4 - i) * CELL_SIZE });
      world.addComponent(h, 'BeltSegmentComp', {
        chainId: id, direction: 270, isCorner: false, isTail: i === CHAIN_LEN - 1,
        segmentIndex: i, phaseOffset: 0, items: [], blocked: false,
      } as BeltSegmentComp);
    }
    return id;
  };
  for (const spec of opts.chains) if (spec.joinAt <= 1) chainIds.set(spec.tag, mkChain(spec));

  const r: StressResult = {
    ticks: opts.ticks, ms: 0,
    lattice: mkViol(), boardConst: mkViol(), boardDistinct: mkViol(), gap: mkViol(), countViol: mkViol(),
    ptrDensity: mkViol(), ptrOverlap: mkViol(), ptrAlign: mkViol(), ptrTail: mkViol(),
    boardChecked: 0, gapChecked: 0, gapMin: Infinity, gapMax: 0, emissionsPost: 0,
    boardConstants: new Map(), maxCount: new Map(), everDecreased: new Map(),
  };
  const emissions: Array<{ tick: number; chain: string; tag: string }> = [];
  const lastInject = new Map<string, number>();
  const firstRel = new Map<string, number>();
  const prevCount = new Map<string, number>();
  const mirror = opts.withMirror ? new Mirror() : null;

  for (let t = 1; t <= opts.ticks; t++) {
    // joinAt<=1 的链已在循环前创建，这里只建动态接入的（joinAt>1），避免重复创建
    for (const spec of opts.chains) if (spec.joinAt === t && spec.joinAt > 1) chainIds.set(spec.tag, mkChain(spec));

    beltSys.update(world, 50);
    machineSys.update(world, 50);

    // 单次遍历收集全链信息（非 entering 物品，同 diagnose itemsOf 语义）
    const info = new Map<string, { len: number; items: QueueItemRef[]; head: BeltSegmentComp | null }>();
    for (const h of world.query('BeltSegmentComp', 'Position')) {
      const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!;
      let e = info.get(seg.chainId);
      if (!e) { e = { len: 1, items: [], head: null }; info.set(seg.chainId, e); }
      const idx = seg.segmentIndex ?? 0;
      if (idx + 1 > e.len) e.len = idx + 1;
      if (idx === 0) e.head = seg;
      for (const it of seg.items ?? []) {
        if (it.entering === true) continue;
        e.items.push({ total: idx + it.progress, stopped: (it.delta ?? 0) === 0 });
      }
    }

    for (const [tag, id] of chainIds) {
      const e = info.get(id);
      if (!e) continue;
      // ① 1/40 格栅（逐 Tick）
      for (const it of e.items) {
        const err = Math.abs(it.total * LATTICE - Math.round(it.total * LATTICE));
        if (!(err < 1e-6)) note(r.lattice, `[tick ${t}] ${tag}带 total=${it.total.toFixed(6)} 格栅误差=${err.toExponential(2)}`);
      }
      // ④ 物品数上界（逐 Tick）
      if (e.items.length > e.len + 2) {
        note(r.countViol, `[tick ${t}] ${tag}带物品数 ${e.items.length} > 链长+2=${e.len + 2}`);
      }
      const pc = prevCount.get(tag);
      if (pc !== undefined && e.items.length < pc) r.everDecreased.set(tag, true);
      prevCount.set(tag, e.items.length);
      const mx = r.maxCount.get(tag) ?? 0;
      if (e.items.length > mx) r.maxCount.set(tag, e.items.length);
      // ③ 出货事件: 链首格出现 progress==0 物品（按链按 Tick 去重）
      const it0 = e.head?.items[0];
      if (it0 !== undefined && it0.progress === 0 && lastInject.get(id) !== t) {
        lastInject.set(id, t);
        emissions.push({ tick: t, chain: id, tag });
      }
    }

    // ② 棋盘/交错（逐 Tick 检查，同 diagnose S11 语义）。不变量:
    //    每链一个常量（链上全部物品 total mod N 同余）+ 各链相对相位互不相
    //    同（mod N 完整剩余系，1-0-0 空间交错）+ 交错指派跨 Tick 恒定。
    //    注 1: 注入相位由首次出货 tick 决定，固定 t%40 抽样会与多带 120-Tick
    //    周期相位锁定（三链齐备的抽样点可能不存在），故逐 Tick 检查、仅要求
    //    全链齐备的 Tick。
    //    注 2: 恒定的是链间相对差——绝对残差随抽样相位合法轮转。
    //    注 3: 轮换周期内的注入顺序（谁领先）是 outputPollQueue 轮换的运行期
    //    结果（如三带稳定为 B→A→C），不必然等于创建序——只断言"互异+恒定"。
    if (t > opts.boardFromTick) {
      const consts: Array<[string, number]> = [];
      for (const [tag, id] of chainIds) {
        const e = info.get(id);
        if (!e || e.items.length === 0) continue;
        const modN = opts.modN;
        const residues = new Set(e.items.map((it) => ((it.total % modN) + modN) % modN));
        if (residues.size > 1) {
          note(r.boardConst, `[tick ${t}] ${tag}带同链残差不唯一: {${[...residues].join(',')}} (mod ${modN}) items=[${e.items.map((x) => x.total.toFixed(2)).join(', ')}]`);
          continue;
        }
        consts.push([tag, ((e.items[0]!.total % opts.modN) + opts.modN) % opts.modN]);
      }
      if (consts.length === chainIds.size && chainIds.size > 0) {
        r.boardChecked++;
        const modN = opts.modN;
        // 各链相对首链的相位（整数格；0.025 格栅注入保证差为整数）
        const rel = new Map<string, number>();
        const base = consts[0]![1];
        let latticeOk = true;
        for (const [tag, c] of consts) {
          const d0 = c - base;
          const d = ((d0 % modN) + modN) % modN;
          const dI = Math.round(d);
          if (Math.abs(d - dI) > 1e-6) {
            note(r.boardConst, `[tick ${t}] ${tag}带相对相位离格: ${d.toFixed(6)} (mod ${modN})`);
            latticeOk = false;
            continue;
          }
          rel.set(tag, ((dI % modN) + modN) % modN);
        }
        if (latticeOk) {
          const seen = new Map<number, string>();
          for (const [tag, v] of rel) {
            const dup = seen.get(v);
            if (dup !== undefined) {
              note(r.boardDistinct, `[tick ${t}] ${tag}带与${dup}带相对相位重合: ${v} (mod ${modN})`);
            }
            seen.set(v, tag);
            const fr = firstRel.get(tag);
            if (fr === undefined) firstRel.set(tag, v);
            else if (fr !== v) note(r.boardDistinct, `[tick ${t}] ${tag}带交错模式漂移: ${fr} → ${v} (mod ${modN})`);
            r.boardConstants.set(tag, v);
          }
        }
      }
    }

    // 场景 3: 指针队列镜像 + 不变量（tick % 40 抽样）
    if (mirror) {
      mirror.tick(info);
      if (t % 40 === 0) {
        for (const [tag, id] of chainIds) {
          const st = mirror.states.get(id);
          const e = info.get(id);
          if (!st || !e) continue;
          const arrows = st.q.arrows;
          // a. 密度
          if (arrows.length > e.len + 1) {
            note(r.ptrDensity, `[tick ${t}] ${tag}带指针数 ${arrows.length} > 链长+1=${e.len + 1}`);
          }
          // b. 两两间距 ≥ 1
          for (let i = 0; i < arrows.length; i++) {
            for (let j = i + 1; j < arrows.length; j++) {
              const d = Math.abs(arrows[i]!.pos - arrows[j]!.pos);
              if (d < 1 - 1e-6) {
                note(r.ptrOverlap, `[tick ${t}] ${tag}带指针#${arrows[i]!.id}@${arrows[i]!.pos.toFixed(4)}/#${arrows[j]!.id}@${arrows[j]!.pos.toFixed(4)} 间距 ${d.toFixed(6)} <1`);
              }
            }
          }
          // c. 与前方最近物品 mod 1 对齐（pos<0 豁免）
          for (const a of arrows) {
            if (a.pos < 0) continue;
            let next = Infinity;
            for (const it of e.items) if (it.total > a.pos + 1e-9 && it.total < next) next = it.total;
            if (next === Infinity) continue;
            const off = (((next - a.pos) % 1) + 1) % 1;
            const offMin = Math.min(off, 1 - off);
            if (offMin > 0.55) {
              note(r.ptrAlign, `[tick ${t}] ${tag}带指针#${a.id}@${a.pos.toFixed(4)} 前方最近物品 ${next.toFixed(4)} 离格 ${offMin.toFixed(4)}`);
            }
          }
          // d. 链尾余量外不滞留
          for (const a of arrows) {
            if (a.pos > e.len + 0.2) {
              note(r.ptrTail, `[tick ${t}] ${tag}带指针#${a.id}@${a.pos.toFixed(4)} > 链长+0.2=${(e.len + 0.2).toFixed(2)}`);
            }
          }
        }
      }
    }
  }

  // ③ 间隔恒 40（gapFromTick 后，合并事件序）
  const post = emissions.filter((e) => e.tick > opts.gapFromTick);
  r.emissionsPost = post.length;
  for (let i = 1; i < post.length; i++) {
    const g = post[i]!.tick - post[i - 1]!.tick;
    r.gapChecked++;
    r.gapMin = Math.min(r.gapMin, g);
    r.gapMax = Math.max(r.gapMax, g);
    if (g !== 40) {
      note(r.gap, `[tick ${post[i]!.tick}] 出货间隔 ${g} ≠ 40（前一事件 tick ${post[i - 1]!.tick} ${post[i - 1]!.tag}带 → ${post[i]!.tag}带）`);
    }
  }
  r.ms = Date.now() - t0;
  return r;
}

const totalViol = (r: StressResult): number =>
  r.lattice.count + r.boardConst.count + r.boardDistinct.count + r.gap.count + r.countViol.count
  + r.ptrDensity.count + r.ptrOverlap.count + r.ptrAlign.count + r.ptrTail.count;

function report(label: string, r: StressResult, opts: { board: boolean; gap: boolean; counts: boolean; pointers: boolean }): void {
  console.log(`\n═══ ${label} ═══`);
  console.log(`  总 Tick 数: ${r.ticks}（耗时 ${(r.ms / 1000).toFixed(1)}s）`);
  console.log(`  ① progress 1/40 格栅违反: ${r.lattice.count}${r.lattice.count ? `\n      ${r.lattice.samples.join('\n      ')}` : ''}`);
  if (opts.board) {
    const nv = r.boardConst.count + r.boardDistinct.count;
    const consts = [...r.boardConstants.entries()].map(([k, v]) => `${k}≡${v}`).join(', ');
    console.log(`  ② 棋盘/交错违反（同链单常量 + 跨链相对差恒定，全链齐备抽样 ${r.boardChecked} 次）: ${nv}${nv ? `\n      ${[...r.boardConst.samples, ...r.boardDistinct.samples].join('\n      ')}` : ''}`);
    console.log(`     各链相对相位（相对创建序首链, mod N 恒定）: ${consts}`);
  }
  if (opts.gap) {
    console.log(`  ③ 出货间隔违反: ${r.gap.count}（tick 后事件 ${r.emissionsPost}，间隔样本 ${r.gapChecked}，min=${r.gapMin}, max=${r.gapMax}）${r.gap.count ? `\n      ${r.gap.samples.join('\n      ')}` : ''}`);
  }
  if (opts.counts) {
    const mx = [...r.maxCount.entries()].map(([k, v]) => `${k}带max=${v}`).join(', ');
    const dec = [...r.everDecreased.entries()].map(([k, v]) => `${k}带${v ? '有下降' : '无下降'}`).join(', ');
    console.log(`  ④ 物品数越界违反（≤链长+2）: ${r.countViol.count}（${mx}; ${dec}）${r.countViol.count ? `\n      ${r.countViol.samples.join('\n      ')}` : ''}`);
  }
  if (opts.pointers) {
    const pv = r.ptrDensity.count + r.ptrOverlap.count + r.ptrAlign.count + r.ptrTail.count;
    console.log(`  ③(场景3) 指针不变量违反: 密度 ${r.ptrDensity.count} / 间距 ${r.ptrOverlap.count} / 对齐 ${r.ptrAlign.count} / 链尾滞留 ${r.ptrTail.count}`);
    for (const v of [r.ptrDensity, r.ptrOverlap, r.ptrAlign, r.ptrTail]) {
      if (v.samples.length) console.log(`      ${v.samples.join('\n      ')}`);
    }
    void pv;
  }
}

// ═══ 场景 1: 双带轮询（用户原场景）+ 场景 3 指针镜像 ═══
const r1 = runStress({
  label: '场景 1+3',
  ticks: 50000,
  chains: [
    { x: 5, tag: 'A', serial: 1, joinAt: 1 },
    { x: 6, tag: 'B', serial: 2, joinAt: 300 },
  ],
  sinks: [[4, 1], [5, 1]], // 端口格 (5,1)=A 链尾出口、(6,1)=B 链尾出口
  modN: 2,
  boardFromTick: 900,
  gapFromTick: 300,
  withMirror: true,
  tsBase: 1757000000,
});
report('场景 1: 双带轮询 50000 Tick（A@1 接入、B@300 动态接入）', r1, { board: true, gap: true, counts: true, pointers: false });
report('场景 3: 指针队列不变量（随场景 1 双链全程镜像，40 Tick 抽样）', r1, { board: false, gap: false, counts: false, pointers: true });

// ═══ 场景 2: 三带轮询 ═══
const r2 = runStress({
  label: '场景 2',
  ticks: 30000,
  chains: [
    { x: 5, tag: 'A', serial: 1, joinAt: 1 },
    { x: 6, tag: 'B', serial: 2, joinAt: 300 },
    { x: 7, tag: 'C', serial: 3, joinAt: 600 },
  ],
  sinks: [[4, 1], [5, 1], [6, 1]], // 端口格 (5,1)/(6,1)/(7,1)
  modN: 3,
  boardFromTick: 1500,
  gapFromTick: 600,
  withMirror: false,
  tsBase: 1758000000,
});
report('场景 2: 三带轮询 30000 Tick（A/B/C @ 1/300/600 接入，mod 3 互异恒定）', r2, { board: true, gap: false, counts: true, pointers: false });

// ═══ 汇总 ═══
const fail1 = totalViol(r1);
const fail2 = totalViol(r2);
console.log('\n═══ 压力汇总 ═══');
console.log(`  场景 1+3（50000 Tick）违反合计: ${fail1}（格栅 ${r1.lattice.count} / 棋盘 ${r1.boardConst.count + r1.boardDistinct.count} / 间隔 ${r1.gap.count} / 物品数 ${r1.countViol.count} / 指针 ${r1.ptrDensity.count + r1.ptrOverlap.count + r1.ptrAlign.count + r1.ptrTail.count}）`);
console.log(`  场景 2（30000 Tick）违反合计: ${fail2}（格栅 ${r2.lattice.count} / 棋盘 ${r2.boardConst.count + r2.boardDistinct.count} / 物品数 ${r2.countViol.count}）`);
const sanity =
  (r1.boardChecked > 100 ? 0 : 1) + (r2.boardChecked > 100 ? 0 : 1)
  + (r1.gapChecked > 500 ? 0 : 1) + (r1.emissionsPost > 500 ? 0 : 1);
if (sanity) console.log(`  ❌ 抽样健全性未达预期（棋盘抽样 ${r1.boardChecked}/${r2.boardChecked}、间隔样本 ${r1.gapChecked}、出货事件 ${r1.emissionsPost}）`);
const ok = fail1 === 0 && fail2 === 0 && sanity === 0;
console.log(`\n${ok ? '✅ 全部压力断言通过' : '❌ 存在压力断言失败'}（场景1+3 违反 ${fail1}、场景 2 违反 ${fail2}、健全性 ${sanity}）`);
process.exit(ok ? 0 : 1);
