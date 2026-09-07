// T2.21 输出轮询纯逻辑验证 — 运行: node --experimental-strip-types scripts/test-output-polling.ts
//
// 复现用户 2026-09-05 拍板的输出端行为规格（传送带上 1=物品 0=空格，从设备端口
// 沿传送带流向数 10 格的快照）:
//   ① 单条带 A: 1-1-1-1-1-1-1-1-1（密集——总速率 = 单带吞吐上限 1 件/40 Tick）
//   ② 两条带 A,B: A: 1-0-1-0-… / B: 0-1-0-1-…；三条带 A,B,C: 各 1-0-0-…
//   ③ 动态接入: A 独跑中在另一端口接入 B → 自动 A-B 轮询，快照
//      A: 0-1-0-1-0-1|1-1-1-1-1（右段=接入前的密集输出） B: 1-0-1-0-1-0|0-0-0-0-0（右段=物品未到的空带）
//   ④ 堵塞跳过: 两条带中 B 永堵 → 货全走 A（A 密集），B 颗粒无收
//   ⑤ 设备级节拍不变式: 任意相邻两次成功出货间隔 ≥ 40 Tick（与带数无关）
//
// 传送带物理按既有 BeltSystem 模型最小化建模（只建模轮询决策依赖的部分）:
// 注入段首 progress=0、+0.025/Tick 推进、一格一物品 → 物品恰在注入后 40 Tick 跨出
// 首格，故"首格可注入" ⇔ 距该带上次注入 ≥ 40 Tick。决策逻辑直接调用产物代码
// OutputOps.syncOutputBeltQueue / pollOutputBelt（纯函数，无渲染依赖）。

import { ITEM_PROGRESS_PER_TICK } from '../src/game/systems/BeltSystem.ts';
import {
  syncOutputBeltQueue,
  pollOutputBelt,
  beltCreationKey,
  tryEmitToBelt,
} from '../src/game/systems/machine/OutputOps.ts';

const INTERVAL = 40; // OUTPUT_EMIT_INTERVAL_TICKS = 1/0.025

interface TestBelt {
  handle: number;
  key: [number, number, number]; // beltCreationKey 元组（创建顺序）
  connectedFrom: number; // 接入 tick（此 Tick 起进入候选集）
  neverAccepts: boolean; // 永堵（断头预置满）
  injections: number[]; // 历次注入 tick
}

/** 从设备端口沿流向数 10 格的占用快照（1=物品 0=空）。 */
function snapshot(belt: TestBelt, T: number, cells = 10): string {
  const occupied = new Set(belt.injections.map((j) => Math.floor((T - j) / INTERVAL)));
  return Array.from({ length: cells }, (_, k) => (occupied.has(k) ? '1' : '0')).join('-');
}

/** 跑一个场景: 每 Tick 同步队列 + 节拍内走访，输出缓冲恒有货（生产跟得上）。 */
function simulate(belts: TestBelt[], untilTick: number): { emissions: Array<{ tick: number; handle: number }> } {
  let queue: number[] = [];
  let nextEmit = 0;
  const emissions: Array<{ tick: number; handle: number }> = [];
  for (let T = 0; T <= untilTick; T++) {
    const candidates = belts
      .filter((b) => b.connectedFrom <= T)
      .sort((a, b) => {
        const [a0, a1, a2] = a.key; const [b0, b1, b2] = b.key;
        return a0 !== b0 ? a0 - b0 : a1 !== b1 ? a1 - b1 : a2 - b2;
      });
    if (T < nextEmit) {
      queue = syncOutputBeltQueue(queue, candidates); // 节拍等待期只同步（对齐 MachineSystem）
      continue;
    }
    const canAccept = (h: number): boolean => {
      const b = belts.find((x) => x.handle === h)!;
      if (b.neverAccepts) return false;
      const last = b.injections[b.injections.length - 1];
      return last === undefined || T - last >= INTERVAL; // 一格一物品: 物品 40 Tick 跨出首格
    };
    const r = pollOutputBelt(queue, candidates, canAccept);
    queue = r.queue;
    if (r.chosen !== null) {
      belts.find((x) => x.handle === r.chosen)!.injections.push(T);
      emissions.push({ tick: T, handle: r.chosen });
      nextEmit = T + INTERVAL;
    }
  }
  return { emissions };
}

let failed = 0;
const assertEq = (label: string, actual: unknown, expected: unknown): void => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${label}: ${ok ? String(actual) : `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`}`);
};

// ── 单元: beltCreationKey 解析 ──
assertEq('beltCreationKey("chain-1754000000000-3", seg 0)', beltCreationKey({ chainId: 'chain-1754000000000-3', segmentIndex: 0 } as never), [1754000000000, 3, 0]);
assertEq('beltCreationKey 非法兜底', beltCreationKey({ chainId: 'oops', segmentIndex: 2 } as never), [0, 0, 2]);

// ── 单元: syncOutputBeltQueue 失效清理 + 新带按创建序追加 ──
{
  const A = { handle: 10 }, B = { handle: 20 }, C = { handle: 30 };
  assertEq('sync: 旧序保留、新带按创建序追加队尾', syncOutputBeltQueue([30, 10], [A, B, C]), [30, 10, 20]);
  assertEq('sync: 失效 handle 移除', syncOutputBeltQueue([10, 99], [A]), [10]);
}

// ── ① 单条带: 密集 ──
{
  const A: TestBelt = { handle: 1, key: [1000, 1, 0], connectedFrom: 0, neverAccepts: false, injections: [] };
  simulate([A], 400);
  assertEq('① 单带 A 快照(密集)', snapshot(A, 400), '1-1-1-1-1-1-1-1-1-1');
}

// ── ② 两条带 / 三条带: 创建序轮询分摊 ──
{
  const A: TestBelt = { handle: 1, key: [1000, 1, 0], connectedFrom: 0, neverAccepts: false, injections: [] };
  const B: TestBelt = { handle: 2, key: [1001, 1, 0], connectedFrom: 0, neverAccepts: false, injections: [] };
  const { emissions } = simulate([A, B], 400);
  assertEq('② 两带 A 快照', snapshot(A, 400), '1-0-1-0-1-0-1-0-1-0');
  assertEq('② 两带 B 快照', snapshot(B, 400), '0-1-0-1-0-1-0-1-0-1');
  void emissions;
}
{
  const A: TestBelt = { handle: 1, key: [1000, 1, 0], connectedFrom: 0, neverAccepts: false, injections: [] };
  const B: TestBelt = { handle: 2, key: [1001, 1, 0], connectedFrom: 0, neverAccepts: false, injections: [] };
  const C: TestBelt = { handle: 3, key: [1002, 1, 0], connectedFrom: 0, neverAccepts: false, injections: [] };
  simulate([A, B, C], 400);
  assertEq('② 三带 A 快照', snapshot(A, 400), '0-1-0-0-1-0-0-1-0-0');
  assertEq('② 三带 B 快照', snapshot(B, 400), '1-0-0-1-0-0-1-0-0-1');
  assertEq('② 三带 C 快照', snapshot(C, 400), '0-0-1-0-0-1-0-0-1-0');
}

// ── ③ 动态接入: A 独跑（tick 200 出货后）接入 B，快照 @440 恰为用户示例 ──
{
  const A: TestBelt = { handle: 1, key: [1000, 1, 0], connectedFrom: 0, neverAccepts: false, injections: [] };
  const B: TestBelt = { handle: 2, key: [1200, 1, 0], connectedFrom: 201, neverAccepts: false, injections: [] };
  const { emissions } = simulate([A, B], 440);
  const tail = emissions.slice(-6).map((e) => (e.handle === 1 ? 'A' : 'B')).join(',');
  assertEq('③ 接入后 6 件轮转 A,B,A,B,A,B', tail, 'A,B,A,B,A,B');
  assertEq('③ 动态接入 A 快照(左=新 交替|右=接入前密集)', snapshot(A, 440), '0-1-0-1-0-1-1-1-1-1');
  assertEq('③ 动态接入 B 快照(右=物品未到的空带)', snapshot(B, 440), '1-0-1-0-1-0-0-0-0-0');
}

// ── ④ 堵塞跳过: B 永堵 → 货全走 A ──
{
  const A: TestBelt = { handle: 1, key: [1000, 1, 0], connectedFrom: 0, neverAccepts: false, injections: [] };
  const B: TestBelt = { handle: 2, key: [1001, 1, 0], connectedFrom: 0, neverAccepts: true, injections: [] };
  simulate([A, B], 400);
  assertEq('④ 堵塞跳过 A 快照(密集)', snapshot(A, 400), '1-1-1-1-1-1-1-1-1-1');
  assertEq('④ 堵塞 B 零接收', B.injections.length, 0);
}

// ── ⑤ 设备级节拍不变式: 相邻成功出货间隔 ≥ 40 ──
{
  const belts = [1, 2, 3, 4].map((i) => ({
    handle: i, key: [1000 + i, 1, 0], connectedFrom: i * 37, neverAccepts: i === 4, injections: [] as number[],
  }));
  const { emissions } = simulate(belts as TestBelt[], 1000);
  const minGap = emissions.slice(1).every((e, i) => e.tick - emissions[i]!.tick >= INTERVAL);
  assertEq('⑤ 相邻出货间隔 ≥ 40 Tick（含动态接入与永堵带）', minGap, true);
}

// ── ⑥ T2.29 统一注入: 段首 0 + 随流 delta ──
// 注入相位 = 出货 Tick 网格（设备级节拍 40 Tick + BeltSystem 1/40 格栅对齐）:
// 同链物品间距恒整数格; 跨链交错 = 节拍差 × 0.025 格/ Tick（双带 40 Tick = 1 格
// → 0-1-0/1-0-1 棋盘）。旧 T2.24 frac(领头) 放置与链哈希自流相位已退役——
// 领头相位是各链历史的任意值，会把任意相对错位冻结进图案（§十三 图2/3 根源）。
{
  assertEq('⑥ 出货节拍 = 1/ITEM_PROGRESS_PER_TICK = 40（栅格对齐前提）', 1 / ITEM_PROGRESS_PER_TICK, 40);
  const comp = { bufferOutput: [{ itemId: 'originium_ore', count: 1 }] } as never;
  const seg = { items: [] as unknown[] } as never;
  const id = tryEmitToBelt(seg, comp, { progress: 0, delta: ITEM_PROGRESS_PER_TICK });
  assertEq('⑥ 机器路径注入: 返回 itemId', id, 'originium_ore');
  assertEq('⑥ 机器路径注入: 段首 0 + 随流 delta', (seg as { items: Array<{ progress: number; delta: number }> }).items[0], { itemId: 'originium_ore', progress: 0, delta: 0.025 });
}

// ── ⑦ T2.24 tryEmitToBelt 按 SlotPlacement 注入 ──
{
  const comp = { bufferOutput: [{ itemId: 'originium_ore', count: 1 }] } as never;
  const seg = { items: [] as unknown[] } as never;
  const id = tryEmitToBelt(seg, comp, { progress: 0.4, delta: 0.025 });
  assertEq('⑦ 放置注入: 返回 itemId', id, 'originium_ore');
  assertEq('⑦ 放置注入: 物品 progress/delta 落位', (seg as { items: Array<{ itemId: string; progress: number; delta: number }> }).items[0], { itemId: 'originium_ore', progress: 0.4, delta: 0.025 });
  assertEq('⑦ 放置注入: 输出槽扣减到 0', (comp as { bufferOutput: Array<{ count: number }> }).bufferOutput[0]!.count, 0);
  const segFull = { items: [{ itemId: 'x', progress: 0.1, delta: 0 }] } as never;
  assertEq('⑦ 满带（一格一物品）拒注', tryEmitToBelt(segFull, comp), null);
  const comp2 = { bufferOutput: [{ itemId: 'originium_ore', count: 1 }] } as never;
  const segEmpty = { items: [] as unknown[] } as never;
  tryEmitToBelt(segEmpty, comp2); // 默认 placement = 段首 0（向后兼容）
  assertEq('⑦ 默认注入段首 progress=0/delta=0', (segEmpty as { items: Array<{ progress: number; delta: number }> }).items[0], { itemId: 'originium_ore', progress: 0, delta: 0 });
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
