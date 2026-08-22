// 传送带堵塞视觉验证: BeltSystem 整链堵塞传播（blocked 字段判定）
// 依据: 用户反馈"队首物品走到头停下后，整条传送带都应进入堵塞(红)状态"
//
// 用法: node --experimental-strip-types scripts/verify-belt-blocked.ts
//
// 断言:
//   1. 断头链: 链尾队首物品停 0.5 → 整链所有段 blocked=true（逆流传播）
//   2. 空段传播: 链尾堵停 → 空的上游段也 blocked=true（整链变红）
//   3. entering 物品（正被设备吸入）→ 不算堵，整链 blocked=false
//   4. 疏通: 移除链尾物品 → 整链 blocked=false（恢复）

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

// ── 场景 3: entering 物品不算堵 ──
{
  const w = new World();
  const [s0, s1, s2] = buildChain(w);
  s2.items.push({ itemId: 'cuprium_ore', progress: 0.9, delta: 0, entering: true });
  sys.update(w, DT);
  assert(s2.blocked === false, '3a. entering 物品（正被吸入）→ 不算堵');
  assert(s1.blocked === false && s0.blocked === false, '3b. 整链不传播堵塞');
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

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
