// T2.4 验证: 输入缓冲区管理（物品进入 + 类型锁定）
// 依据: implementation-phase-2.md T2.4、A8 §2.1 (输入槽规则)、A3 §3 (BufferSlot)
//
// 用法: node --experimental-strip-types scripts/verify-t24-buffer.ts
//
// 断言:
//   槽位创建:
//     1. createBufferSlots(n) → n 个 {itemId:null, count:0} 空槽
//   物品进入 + 锁定 (A8 §2.1):
//     2. 空槽接受任意物品 → 锁定该 itemId，count+1
//     3. 已锁定槽只接受同类型物品，count 递增
//     4. 已锁定槽拒绝不同类型物品（单槽 → tryAcceptItem false）
//     5. 槽满(count=capacity)后同类型也拒绝
//     6. 多槽: 类型不匹配的物品进入下一个空槽（各槽独立锁定）
//     7. 多槽: 同类型物品优先并入已锁定槽（不拆堆到新空槽）
//     8. 所有槽都不接受 → false（物品留在传送带上，T2.6 语义）
//   解锁:
//     9. count 扣减到 0 → 解锁（itemId=null），下一件物品重新决定类型
//    10. 解锁后可锁定不同类型
//    11. consumeFromSlot 扣减不足时钳到 0 并解锁（防御）
//   格式化:
//    12. formatBufferSlots → "输入槽0: 源矿 × 3/50 (已锁定)" / 空槽 → "输入槽0: 空"
import {
  createBufferSlots,
  tryAcceptItem,
  consumeFromSlot,
  formatBufferSlots,
} from '../src/game/systems/machine/BufferOps.ts';

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

const CAP = 50;
const nameOf = (id: string | null): string =>
  ({ originium_ore: '源矿', ferrium_ore: '蓝铁矿' })[id as string] ?? id ?? '';

console.log('[槽位创建]');
const empty1 = createBufferSlots(1);
assertEq(empty1, [{ itemId: null, count: 0 }], '1. createBufferSlots(1) → 1 个空槽');
assertEq(createBufferSlots(3).length, 3, '1b. createBufferSlots(3) → 3 槽');

console.log('[物品进入 + 类型锁定]');
const slots = createBufferSlots(1);
assert(tryAcceptItem(slots, 'originium_ore', CAP) === true, '2. 空槽接受源矿');
assertEq(slots[0], { itemId: 'originium_ore', count: 1 }, '2b. 槽锁定 originium_ore, count=1');

tryAcceptItem(slots, 'originium_ore', CAP);
tryAcceptItem(slots, 'originium_ore', CAP);
assertEq(slots[0].count, 3, '3. 同类型物品 count 递增到 3');

assert(tryAcceptItem(slots, 'ferrium_ore', CAP) === false, '4. 单槽已锁源矿 → 拒绝蓝铁矿');
assertEq(slots[0], { itemId: 'originium_ore', count: 3 }, '4b. 拒绝后槽状态不变');

for (let i = slots[0].count; i < CAP; i++) tryAcceptItem(slots, 'originium_ore', CAP);
assert(tryAcceptItem(slots, 'originium_ore', CAP) === false, '5. 槽满(50/50)后同类型也拒绝');
assertEq(slots[0].count, CAP, '5b. count 钳在 50 不溢出');

const multi = createBufferSlots(2);
tryAcceptItem(multi, 'originium_ore', CAP);
tryAcceptItem(multi, 'originium_ore', CAP);
assert(tryAcceptItem(multi, 'ferrium_ore', CAP) === true, '6. 类型不匹配 → 进入下一个空槽');
assertEq(multi[1], { itemId: 'ferrium_ore', count: 1 }, '6b. 槽1 独立锁定蓝铁矿');

const prefer = createBufferSlots(2);
tryAcceptItem(prefer, 'originium_ore', CAP);
tryAcceptItem(prefer, 'originium_ore', CAP); // 槽0: 源矿×2
tryAcceptItem(prefer, 'ferrium_ore', CAP);   // 槽1: 蓝铁矿×1
tryAcceptItem(prefer, 'originium_ore', CAP); // 应并入槽0 而非开新槽/进槽1
assertEq(prefer[0].count, 3, '7. 同类型优先并入已锁定槽0');
assertEq(prefer[1].count, 1, '7b. 槽1 不受影响');

const full = [{ itemId: 'originium_ore', count: CAP }, { itemId: 'ferrium_ore', count: 2 }];
assert(tryAcceptItem(full, 'amethyst_ore', CAP) === false, '8. 无空槽且无同类型槽 → false');

console.log('[解锁]');
const unlock = [{ itemId: 'originium_ore', count: 3 }];
consumeFromSlot(unlock[0], 1);
assertEq(unlock[0], { itemId: 'originium_ore', count: 2 }, '9. 扣减 1 → 2 仍锁定');
consumeFromSlot(unlock[0], 2);
assertEq(unlock[0], { itemId: null, count: 0 }, '9b. count 到 0 → 解锁 (A8 §2.1)');

assert(tryAcceptItem(unlock, 'ferrium_ore', CAP) === true, '10. 解锁后可锁定不同类型');
assertEq(unlock[0], { itemId: 'ferrium_ore', count: 1 }, '10b. 槽重新锁定蓝铁矿');

const clamp = [{ itemId: 'originium_ore', count: 2 }];
consumeFromSlot(clamp[0], 5);
assertEq(clamp[0], { itemId: null, count: 0 }, '11. 扣减超量 → 钳 0 并解锁');

console.log('[格式化]');
const fmt = [{ itemId: 'originium_ore', count: 3 }];
assertEq(formatBufferSlots(fmt, CAP, nameOf), '输入槽0: 源矿 × 3/50 (已锁定)', '12. 锁定槽格式');
assertEq(formatBufferSlots(createBufferSlots(1), CAP, nameOf), '输入槽0: 空', '12b. 空槽格式');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
