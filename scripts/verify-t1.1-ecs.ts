// T1.1 ECS 核心验证脚本
// 用法: node --experimental-strip-types scripts/verify-t1.1-ecs.ts
//
// 验证 A1/A7 DD-001 的所有关键行为:
//   1. createEntity 返回有效 handle，isAlive=true
//   2. destroyEntity 后 isAlive=false，entityCount 递减
//   3. destroyEntity 幂等（重复调用无副作用）
//   4. generation-based: 销毁后槽位复用，旧 handle 永久失效（新实体拿到新 handle）
//   5. addComponent/getComponent/hasComponent/removeComponent 正确
//   6. 销毁实体后其组件被清空
//   7. query 返回同时拥有指定组件的存活实体
//   8. 对已销毁实体的操作安全（getComponent 返回 undefined，addComponent 抛错）
//   9. generation 回绕到 4096 代后正确取模

import { World } from '../src/game/ECS.ts';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function assertThrows(fn: () => void, msg: string): void {
  try {
    fn();
    assert(false, `${msg} (期望抛错但未抛)`);
  } catch {
    assert(true, msg);
  }
}

console.log('\n=== T1.1 ECS 核心验证 ===\n');

// ── 1. 基础创建与存活判断 ──
console.log('[1] createEntity / isAlive / entityCount');
{
  const world = new World();
  const e1 = world.createEntity();
  const e2 = world.createEntity();
  assert(world.isAlive(e1), '新创建实体 isAlive = true');
  assert(world.isAlive(e2), '第二个实体 isAlive = true');
  assert(world.entityCount() === 2, 'entityCount = 2');
  assert(e1 !== e2, '两个不同实体的 handle 不同');
}

// ── 2. 销毁后失效 ──
console.log('\n[2] destroyEntity / isAlive=false');
{
  const world = new World();
  const e = world.createEntity();
  world.destroyEntity(e);
  assert(!world.isAlive(e), '销毁后 isAlive = false');
  assert(world.entityCount() === 0, '销毁后 entityCount = 0');
}

// ── 3. destroyEntity 幂等 ──
console.log('\n[3] destroyEntity 幂等');
{
  const world = new World();
  const e = world.createEntity();
  world.destroyEntity(e);
  world.destroyEntity(e); // 重复销毁不应抛错、不应影响计数
  world.destroyEntity(e);
  assert(world.entityCount() === 0, '重复销毁 entityCount 仍为 0');
}

// ── 4. generation-based 槽位复用，旧 handle 永久失效 (DD-001 核心) ──
console.log('\n[4] generation-based 槽位复用 (DD-001)');
{
  const world = new World();
  const e1 = world.createEntity();
  world.addComponent(e1, 'Tag', { v: 1 });
  world.destroyEntity(e1);

  // 槽位应被回收复用
  const e2 = world.createEntity();
  // 新 handle 必须 ≠ 旧 handle（generation 已递增）
  assert(e1 !== e2, '复用槽位但 handle 不同 (generation 递增)');
  assert(!world.isAlive(e1), '旧 handle e1 永久失效');
  assert(world.isAlive(e2), '新 handle e2 存活');
  assert(world.entityCount() === 1, 'entityCount = 1');

  // 旧 handle 不能读到新实体的组件 (代数校验阻止悬空引用)
  assert(world.getComponent(e1, 'Tag') === undefined, '旧 handle 读不到新实体组件 (悬空引用被阻断)');
  // 新实体组件从零开始（销毁时已清空）
  assert(world.getComponent(e2, 'Tag') === undefined, '槽位复用后组件从零开始');
}

// ── 5. 组件 CRUD ──
console.log('\n[5] addComponent / getComponent / hasComponent / removeComponent');
{
  const world = new World();
  const e = world.createEntity();
  assert(!world.hasComponent(e, 'Position'), '未添加前 hasComponent = false');

  world.addComponent(e, 'Position', { x: 10, y: 20 });
  assert(world.hasComponent(e, 'Position'), '添加后 hasComponent = true');
  const pos = world.getComponent<{ x: number; y: number }>(e, 'Position');
  assert(pos?.x === 10 && pos?.y === 20, 'getComponent 返回正确数据');

  world.addComponent(e, 'Position', { x: 99, y: 99 }); // 覆盖
  assert(world.getComponent<{ x: number }>(e, 'Position')?.x === 99, 'addComponent 覆盖原值');

  world.removeComponent(e, 'Position');
  assert(!world.hasComponent(e, 'Position'), 'removeComponent 后 hasComponent = false');
  assert(world.getComponent(e, 'Position') === undefined, 'removeComponent 后 getComponent = undefined');
}

// ── 6. 销毁实体清空其全部组件 ──
console.log('\n[6] 销毁实体清空所有组件');
{
  const world = new World();
  const e = world.createEntity();
  world.addComponent(e, 'Position', { x: 1, y: 2 });
  world.addComponent(e, 'Sprite', { tex: 'a' });
  world.destroyEntity(e);
  // 槽位复用后新实体不该看到残留组件
  const e2 = world.createEntity();
  assert(!world.hasComponent(e2, 'Position'), '销毁清空: Position 无残留');
  assert(!world.hasComponent(e2, 'Sprite'), '销毁清空: Sprite 无残留');
}

// ── 7. query 多组件交集 ──
console.log('\n[7] query 多组件交集');
{
  const world = new World();
  const a = world.createEntity(); // Position + Sprite
  const b = world.createEntity(); // 仅 Position
  const c = world.createEntity(); // Position + Sprite + Tag
  const d = world.createEntity(); // 仅 Sprite

  world.addComponent(a, 'Position', { x: 0, y: 0 });
  world.addComponent(a, 'Sprite', { t: 'a' });
  world.addComponent(b, 'Position', { x: 1, y: 1 });
  world.addComponent(c, 'Position', { x: 2, y: 2 });
  world.addComponent(c, 'Sprite', { t: 'c' });
  world.addComponent(c, 'Tag', {});
  world.addComponent(d, 'Sprite', { t: 'd' });

  const both = world.query('Position', 'Sprite');
  assert(both.length === 2, "query('Position','Sprite') = 2 个 (a, c)");
  assert(both.every(h => world.isAlive(h)), 'query 结果全部存活');
  assert(both.includes(a) && both.includes(c) && !both.includes(b) && !both.includes(d),
    'query 命中正确的实体');

  const three = world.query('Position', 'Sprite', 'Tag');
  assert(three.length === 1 && three.includes(c), "query 三组件交集 = 1 个 (c)");

  const none = world.query('NotExist');
  assert(none.length === 0, "query 不存在的组件 = 空数组");
  assert(world.query().length === 0, 'query 无参数 = 空数组');
}

// ── 8. 销毁后的实体不应出现在 query ──
console.log('\n[8] query 排除已销毁实体');
{
  const world = new World();
  const a = world.createEntity();
  const b = world.createEntity();
  world.addComponent(a, 'Position', { x: 0, y: 0 });
  world.addComponent(b, 'Position', { x: 1, y: 1 });
  world.destroyEntity(a);
  const res = world.query('Position');
  assert(res.length === 1 && res.includes(b), 'query 不含已销毁的 a');
}

// ── 9. 对已销毁实体的操作 ──
console.log('\n[9] 对已销毁实体的操作安全');
{
  const world = new World();
  const e = world.createEntity();
  world.destroyEntity(e);
  assert(world.getComponent(e, 'Position') === undefined, '已销毁实体 getComponent = undefined');
  assert(!world.hasComponent(e, 'Position'), '已销毁实体 hasComponent = false');
  // removeComponent 对已销毁实体应静默无操作
  world.removeComponent(e, 'Position');
  assert(true, 'removeComponent 对已销毁实体静默无操作');
  // addComponent 对已销毁实体应抛错（防止脏数据写入）
  assertThrows(() => world.addComponent(e, 'Position', { x: 1, y: 1 }),
    'addComponent 对已销毁实体抛错');
}

// ── 10. generation 回绕 (12 bit = 4096) ──
console.log('\n[10] generation 回绕到 4096');
{
  const world = new World();
  // 在同一槽位反复创建+销毁 4097 次，触发 generation 回绕。
  // 注意: 12 位 generation 在 4096 次销毁后会回绕到 0，此时
  //   handle = (0 << 20) | 0 与初始 handle 数学上相同 —— 这是 DD-001 的
  //   已知理论局限(单槽位需销毁 4096 次才会重合，实际游戏不会触发)。
  //   本测试验证回绕不会导致崩溃、计数与组件操作仍正确。
  const handles: number[] = [];
  for (let i = 0; i < 4097; i++) {
    const h = world.createEntity();
    world.destroyEntity(h);
    handles.push(h);
  }
  assert(world.entityCount() === 0, '回绕后 entityCount = 0');
  // 回绕后再次创建应功能正常
  const fresh = world.createEntity();
  assert(world.isAlive(fresh), '回绕后新实体存活正常');
  world.addComponent(fresh, 'Position', { x: 7, y: 7 });
  assert(world.getComponent<{ x: number }>(fresh, 'Position')?.x === 7, '回绕后组件操作正常');
  world.destroyEntity(fresh);
  assert(!world.isAlive(fresh), '回绕后销毁正常');
}

// ── 11. 批量实体压力 (100+) ──
console.log('\n[11] 批量实体 (Phase 1 目标 100)');
{
  const world = new World();
  const handles: number[] = [];
  for (let i = 0; i < 150; i++) {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: i, y: 0 });
    handles.push(h);
  }
  assert(world.entityCount() === 150, '创建 150 个实体');
  const q = world.query('Position');
  assert(q.length === 150, 'query 全部 150 个');

  // 销毁一半
  for (let i = 0; i < 150; i += 2) {
    world.destroyEntity(handles[i]);
  }
  assert(world.entityCount() === 75, '销毁一半后 entityCount = 75');
  assert(world.query('Position').length === 75, 'query 剩余 75 个');
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
if (failed > 0) {
  process.exit(1);
}
