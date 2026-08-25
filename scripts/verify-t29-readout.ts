// T2.9b 验证: 选中设备最小读数（临时件）——纯逻辑（格式化 + 非生产设备过滤）
// 依据: implementation-phase-2.md T2.9（2026-08-24 修订版 9b）
//
// 用法: node --experimental-strip-types scripts/verify-t29-readout.ts
//
// 断言:
//   1. 生产设备: 各槽 count 求和 → "输入: x/50　输出: y/50" 单行文本
//   2. 空缓冲区 → "输入: 0/50　输出: 0/50"
//   3. 多槽位求和（未来多槽设备等价）
//   4. 仓库取货口/存货口（无任何槽位）→ null（T2.9 读数不显示数据）
import { readFileSync } from 'node:fs';
import { BUILDING_DEFINITIONS, createOutputPollQueue } from '../src/game/data/buildings.ts';
import { createBufferSlots } from '../src/game/systems/machine/BufferOps.ts';
import { deviceReadoutText } from '../src/game/ui/DeviceReadout.ts';
import type { BuildingComp } from '../src/game/components/BuildingComp.ts';

let passed = 0, failed = 0;
function assertEq<T>(actual: T, expected: T, msg: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${msg}`); }
  else {
    failed++;
    console.error(`  ❌ ${msg}\n       期望: ${JSON.stringify(expected)}\n       实际: ${JSON.stringify(actual)}`);
  }
}

const furnaceDef = BUILDING_DEFINITIONS.refining_unit;
const mkComp = (id: string): BuildingComp => ({
  definitionId: id, direction: 0, state: 'idle', paused: false,
  bufferInput: createBufferSlots(BUILDING_DEFINITIONS[id]?.inputSlotCount ?? 0),
  bufferOutput: createBufferSlots(BUILDING_DEFINITIONS[id]?.outputSlotCount ?? 0),
  inputPollIndex: 0, // T2.10
  outputPollQueue: BUILDING_DEFINITIONS[id] ? createOutputPollQueue(BUILDING_DEFINITIONS[id]) : [],
  currentRecipeId: null, progress: 0, elapsed: 0,
});

console.log('[deviceReadoutText 格式化]');
{
  const comp = mkComp('refining_unit');
  comp.bufferInput[0] = { itemId: 'originium_ore', count: 23 };
  comp.bufferOutput[0] = { itemId: 'origocrust', count: 7 };
  assertEq(deviceReadoutText(comp, furnaceDef), '输入: 23/50　输出: 7/50',
    '1a. 精炼炉 23/7 → 单行 "输入: 23/50　输出: 7/50"');
}
{
  const comp = mkComp('refining_unit');
  assertEq(deviceReadoutText(comp, furnaceDef), '输入: 0/50　输出: 0/50',
    '2a. 空缓冲区 → "输入: 0/50　输出: 0/50"');
}
{
  const comp = mkComp('refining_unit');
  comp.bufferInput = [
    { itemId: 'originium_ore', count: 10 },
    { itemId: 'originium_ore', count: 5 },
  ];
  assertEq(deviceReadoutText(comp, furnaceDef), '输入: 15/50　输出: 0/50',
    '3a. 多槽位 count 求和（10+5=15）');
}

console.log('[非生产设备过滤]');
assertEq(deviceReadoutText(mkComp('depot_unloader'), BUILDING_DEFINITIONS.depot_unloader), null,
  '4a. 仓库取货口 → null（无缓冲区，读数不显示任何数据）');
assertEq(deviceReadoutText(mkComp('depot_loader'), BUILDING_DEFINITIONS.depot_loader), null,
  '4b. 仓库存货口 → null（同上）');

console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.error('❌ T2.9b 读数验证失败');
  process.exit(1);
}
console.log('✅ T2.9b 读数全部断言通过');
void readFileSync;
