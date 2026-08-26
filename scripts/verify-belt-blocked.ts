// 传送带堵塞视觉验证: BeltSystem 链级堵塞判定（blocked 字段）
// 依据: 用户反馈"队首物品走到头停下后，整条传送带都应进入堵塞(红)状态"；
//       2026-08-25 用户实测修订: 红色堵塞要覆盖**完整条**传送带（含门口格吸入
//       行走期间——端口前一格无需特殊处理）→ 判定改为链级: 链内任一物品停走
//       （delta=0）→ 整链 blocked。
//
// 用法: node --experimental-strip-types scripts/verify-belt-blocked.ts
//
// 断言:
//   1. 断头链: 链尾队首物品停 0.5 → 整链所有段 blocked=true
//   2. 空段传播: 链尾堵停 → 空的上游段也 blocked=true（整链变红）
//   3. entering 物品单独行进（链上无停走物品）→ 整链 blocked=false（正常排空）
//   4. 疏通: 移除链尾物品 → 整链 blocked=false（恢复）
//   5. 门口格 entering 行走 + 后方排队停走 → **整链 blocked=true（含门口格）**
//      ——2026-08-25 修订的核心场景

import { World } from '../src/game/ECS.ts';
import { BeltSystem } from '../src/game/systems/BeltSystem.ts';
import { CELL_SIZE } from '../src/game/render/constants.ts';
import type { BeltSegmentComp } from '../src/game/components/BeltSegmentComp.ts';

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const DT = 50;
const sys = new BeltSystem();

// 建一条 3 格直链（朝右 0），返回三段组件（段0→段1→段2，段2 断头）。
// 段0 是链首（空），段1 中游（空），段2 链尾断头——覆盖"空段也参与传播"。
function buildChain(world: World): BeltSegmentComp[] {
  const mk = (gx: number, isTail: boolean): BeltSegmentComp => {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: 0 });
    const s: BeltSegmentComp = {
      chainId: 'c1', direction: 0, isCorner: false, isTail,
      segmentIndex: gx, phaseOffset: 0, items: [],
    };
    world.addComponent(h, 'BeltSegmentComp', s);
    return s;
  };
  return [mk(0, false), mk(1, false), mk(2, true)];
}

// ── 场景 1+2: 断头链整链传播（含空段）──
{
  const w = new World();
  const [s0, s1, s2] = buildChain(w);
  // 链尾段放一个已堵停物品（断头/满槽语义: 停在 0.5, delta=0, 非 entering）
  s2.items.push({ itemId: 'cuprium_ore', progress: 0.5, delta: 0 });
  sys.update(w, DT);
  assert(s2.blocked === true, '1a. 链尾断头段队首停 0.5 → blocked=true');
  assert(s1.blocked === true, '1b. 中游空段逆流传播 → blocked=true（整链变红）');
  assert(s0.blocked === true, '1c. 链首空段也传播 → blocked=true（空段参与传播）');
}

// ── 场景 3: entering 物品单独行进（链上无停走物品）→ 不算堵 ──
{
  const w = new World();
  const [s0, s1, s2] = buildChain(w);
  // 真实仿真中 entering 物品每 Tick 前进（delta=0.025），此处按行走中建模
  s2.items.push({ itemId: 'cuprium_ore', progress: 0.9, delta: 0.025, entering: true });
  sys.update(w, DT);
  assert(s2.blocked === false, '3a. entering 物品行进中（链上无停走物品）→ 不算堵');
  assert(s1.blocked === false && s0.blocked === false, '3b. 整链不堵塞');
}

// ── 场景 4: 疏通恢复 ──
{
  const w = new World();
  const [s0, s1, s2] = buildChain(w);
  s2.items.push({ itemId: 'cuprium_ore', progress: 0.5, delta: 0 });
  sys.update(w, DT); // 堵
  assert(s0.blocked === true && s1.blocked === true && s2.blocked === true, '4a. (前置) 整链已堵');
  s2.items.length = 0; // 疏通（设备吸入/取走）
  sys.update(w, DT);
  assert(s2.blocked === false, '4b. 链尾疏通 → 链尾 blocked=false');
  assert(s0.blocked === false && s1.blocked === false, '4c. 整链恢复 blocked=false');
}

// ── 场景 5: 门口格 entering 行走 + 后方排队停走 → 整链红（含门口格）──
// 2026-08-25 用户实测修订的核心场景: 旧规则下门口格（entering 行走 delta>0）
// 不算堵 → 红色只覆盖后方排队格、门口格留黄。链级判定后整链红。
{
  const w = new World();
  const [s0, s1, s2] = buildChain(w);
  s2.items.push({ itemId: 'cuprium_ore', progress: 1.2, delta: 0.025, entering: true }); // 门口件走进设备
  s1.items.push({ itemId: 'cuprium_ore', progress: 0.5, delta: 0 }); // 后方排队停走（停格中心）
  s0.items.push({ itemId: 'cuprium_ore', progress: 0.5, delta: 0 }); // 再后排
  sys.update(w, DT);
  assert(s0.blocked === true && s1.blocked === true && s2.blocked === true,
    '5a. 门口格 entering + 后方排队停走 → 整链 blocked（红色覆盖完整条传送带）');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
