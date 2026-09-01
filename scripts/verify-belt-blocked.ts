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
//   5. 门口格 entering 行走 → 后方物品**跟进流动**（2026-09-02 修订: entering 过客
//      不占供给格，行走期间整链 delta>0 不红）
//   真堵分类（2026-09-02 用户实测修订: 轮询等待闪红误导玩家）:
//   6. 满载+working（轮询等待，几秒内轮到补货）→ 不红 | 7. 满载+停产 → 红
//   8. 类型不符 → 红 | 9. 槽可收瞬态 → 不红 | 10. paused（LOGO 指示）→ 不红
//  11. 传导: 上游链随下游链（下游不红→不红; 断头红→红）
//      ——2026-08-25 修订的核心场景

import { World } from '../src/game/ECS.ts';
import { BeltSystem } from '../src/game/systems/BeltSystem.ts';
import { CELL_SIZE } from '../src/game/render/constants.ts';
import type { BeltSegmentComp } from '../src/game/components/BeltSegmentComp.ts';
import type { BuildingComp } from '../src/game/components/BuildingComp.ts';

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

// ── 场景 5: 门口格 entering 行走 → 后方物品跟进流动（2026-09-02 修订）──
// 2026-08-25 旧行为: entering 物品占用供给格，后方排队停自己格中心（delta=0）→ 整链红。
// 2026-09-02 用户日志实测否决（带速被腰斩 4s/件、三带输入加不了速）: entering 是设备
// 所有的过客，不计入下游阻挡——后件到段尾即跟进供给格与前件锁步（≥1 格间距），
// 传送带以本速 2s/件连续流入。行走期间链上全部 delta>0 → 不红（真堵才红）。
{
  const w = new World();
  const [s0, s1, s2] = buildChain(w);
  s2.items.push({ itemId: 'cuprium_ore', progress: 1.2, delta: 0.025, entering: true }); // 门口件走进设备
  s1.items.push({ itemId: 'cuprium_ore', progress: 0.5, delta: 0 }); // 后方件（旧: 停走; 新: 跟进）
  s0.items.push({ itemId: 'cuprium_ore', progress: 0.5, delta: 0 }); // 再后件
  sys.update(w, DT);
  assert(s1.items[0].delta > 0,
    '5a. entering 行走期间后方物品跟进流动（delta>0，不再停在格中心等释放）');
  assert(s0.items[0].delta > 0, '5b. 更后方的物品随队列推进（整链流动）');
  assert(s0.blocked === false && s1.blocked === false && s2.blocked === false,
    '5c. 行走期间整链流动不红（红色仅留给真堵——满槽/类型不符，场景 2/4 覆盖）');
}


// ── 真堵分类（2026-09-02）: 设备对接链的红色只给真堵，轮询等待不红 ──
/** 放一台最小 BuildingComp 设备（BeltSystem 真堵分类只读 definitionId/direction/槽/状态）。 */
function placeBuilding(
  w: World, defId: 'refining_unit' | 'depot_loader', gx: number, gy: number,
  slots: Array<{ itemId: string | null; count: number }>,
  state: 'idle' | 'working' | 'blocked', paused = false,
): BuildingComp {
  const h = w.createEntity();
  w.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
  const comp: BuildingComp = {
    definitionId: defId, direction: 0, state,
    bufferInput: slots, bufferOutput: [],
    inputPollIndex: 0, outputPollQueue: [],
    currentRecipeId: null, progress: 0, elapsed: 0, paused,
  };
  w.addComponent(h, 'BuildingComp', comp);
  return comp;
}

/**
 * 垂直三段上行链 (0,2)→(0,1)→(0,0)，链尾出口 (0,-1)。
 * 精炼炉放 (-1,-3)（占 x=-1..1,y=-3..-1，底排输入口含 (0,-1)）→ 链对接设备输入口。
 */
function buildDoorChain(w: World): [BeltSegmentComp, BeltSegmentComp, BeltSegmentComp] {
  const mk = (gy: number): BeltSegmentComp => {
    const h = w.createEntity();
    w.addComponent(h, 'Position', { x: 0, y: gy * CELL_SIZE });
    const s: BeltSegmentComp = {
      chainId: 'door', direction: 270, isCorner: false, isTail: gy === 0,
      segmentIndex: 2 - gy, phaseOffset: 0, items: [],
    };
    w.addComponent(h, 'BeltSegmentComp', s);
    return s;
  };
  return [mk(2), mk(1), mk(0)];
}

function stockDoorChain(a: BeltSegmentComp, b: BeltSegmentComp, c: BeltSegmentComp): void {
  c.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  b.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  a.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
}

{
  const w = new World();
  const [h0, h1, h2] = buildDoorChain(w);
  placeBuilding(w, 'refining_unit', -1, -3, [{ itemId: 'originium_ore', count: 50 }], 'working');
  stockDoorChain(h0, h1, h2);
  sys.update(w, DT);
  assert(h0.blocked === false && h1.blocked === false && h2.blocked === false,
    '6. 满载+生产 working（轮询等待——几秒内腾位轮到本带）→ 不红');
}

{
  const w = new World();
  const [h0, h1, h2] = buildDoorChain(w);
  placeBuilding(w, 'refining_unit', -1, -3, [{ itemId: 'originium_ore', count: 50 }], 'blocked');
  stockDoorChain(h0, h1, h2);
  sys.update(w, DT);
  assert(h0.blocked === true && h1.blocked === true && h2.blocked === true,
    '7. 满载+停产（blocked 输出满，输入只进不出）→ 整链红');
}

{
  const w = new World();
  const [h0, h1, h2] = buildDoorChain(w);
  placeBuilding(w, 'refining_unit', -1, -3, [{ itemId: 'origocrust', count: 3 }], 'idle');
  stockDoorChain(h0, h1, h2);
  sys.update(w, DT);
  assert(h2.blocked === true && h0.blocked === true,
    '8. 类型不符（槽锁晶体外壳、带上源矿，槽未满也不收）→ 整链红');
}

{
  const w = new World();
  const [h0, h1, h2] = buildDoorChain(w);
  placeBuilding(w, 'refining_unit', -1, -3, [{ itemId: 'originium_ore', count: 3 }], 'idle');
  stockDoorChain(h0, h1, h2);
  sys.update(w, DT);
  assert(h2.blocked === false && h0.blocked === false,
    '9. 槽可收（同型未满——本 Tick 即将被 MachineSystem 吸入的瞬态）→ 不红');
}

{
  const w = new World();
  const [h0, h1, h2] = buildDoorChain(w);
  placeBuilding(w, 'refining_unit', -1, -3, [{ itemId: 'originium_ore', count: 50 }], 'working', true);
  stockDoorChain(h0, h1, h2);
  sys.update(w, DT);
  assert(h2.blocked === false && h0.blocked === false,
    '10. paused（玩家主动关停由 LOGO 指示，T2.8 语义同端口不红）→ 不红');
}

// 11. 传导: 上游链流入不红链 → 不红; 流入断头链 → 红
{
  // 11a: 下游链对接存货口（无限汇，不红）→ 上游停走链不红
  const w = new World();
  const [h0, , h2] = buildDoorChain(w); // 上游链出口 (0,-1)
  const dh = w.createEntity(); // 下游链单段 (0,-1) 方向 270，出口 (0,-2)
  w.addComponent(dh, 'Position', { x: 0, y: -CELL_SIZE });
  const ds: BeltSegmentComp = {
    chainId: 'down', direction: 270, isCorner: false, isTail: true,
    segmentIndex: 0, phaseOffset: 0, items: [],
  };
  w.addComponent(dh, 'BeltSegmentComp', ds);
  placeBuilding(w, 'depot_loader', -1, -2, [], 'idle'); // loader 占 (-1..1,-2)，端口含 (0,-2)
  h2.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  h0.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  ds.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  sys.update(w, DT);
  assert(ds.blocked === false, '11a-a. 下游链停走但对接存货口（无限汇瞬态）→ 不红');
  assert(h0.blocked === false && h2.blocked === false, '11a-b. 上游链传导等待（下游不红）→ 不红');

  // 11b: 下游链断头（红）→ 上游红
  const w2 = new World();
  const [u0, , u2] = buildDoorChain(w2);
  const dh2 = w2.createEntity();
  w2.addComponent(dh2, 'Position', { x: 0, y: -CELL_SIZE });
  const ds2: BeltSegmentComp = {
    chainId: 'down2', direction: 270, isCorner: false, isTail: true,
    segmentIndex: 0, phaseOffset: 0, items: [],
  };
  w2.addComponent(dh2, 'BeltSegmentComp', ds2);
  u2.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  u0.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  ds2.items.push({ itemId: 'originium_ore', progress: 0.5, delta: 0 });
  sys.update(w2, DT);
  assert(ds2.blocked === true, '11b-a. 下游链断头 → 红');
  assert(u0.blocked === true && u2.blocked === true, '11b-b. 上游链流入红链（传导拥堵）→ 红');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
