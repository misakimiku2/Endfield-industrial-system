// T2.16 验证: 传送带终点对接（端口重定向 / 末段方向重放 / 对接信息）
// 依据: implementation-phase-2.md T2.16 + 2026-09-02 端口重定向三轮修订——
//       dockTargetAt / applyDockSnap / incomingDirOf 退役，现行 API:
//       dockRedirect（寻路目标重定向到朝向侧供给格）+ applySnapToCells（末格方向
//       重放）+ dockInfoOf（仅 confirmed，候选紫 targets 已按用户要求移除）。
//
// 用法: node --experimental-strip-types --experimental-loader ./scripts/ts-loader.mjs \
//         scripts/verify-t216-dock.ts
//       （经 IntakeOps → BeltChainOps 的无后缀 import 需要 loader 解析）
//
// 断言:
//   IntakeOps.collectInputPortCells（端口格权威索引）:
//     1. 精炼炉 0° → 底排 3 输入口（outward=90 下）；输出/液体口不收录
//     2. 精炼炉 90° → 左列；多台设备合并收录
//   BeltDockOps.dockRedirect（端口重定向）:
//     3. mouse 在端口格 → target=朝向侧供给格 + snap 逆朝向指向端口
//     4. mouse 在普通格/供给格 → null（重定向只在端口格触发）
//   BeltDockOps.applySnapToCells（末格方向重放）:
//     5. 末格与吸附格重合且非 180° 折返 → 覆盖方向；不重合/折返 → 不写入
//   BeltDockOps.dockInfoOf（对接信息）:
//     6. confirmed = 末段从朝向侧供给格指向的那个端口格（侧向横穿不算）；
//        targets 候选已移除
import { World } from '../src/game/ECS.ts';
import { getBuildingDefinition } from '../src/game/data/buildings.ts';
import { collectInputPortCells } from '../src/game/systems/machine/IntakeOps.ts';
import { inputPortCells } from '../src/game/systems/PortGeometry.ts';
import {
  dockRedirect,
  applySnapToCells,
  dockInfoOf,
  portKey,
} from '../src/game/systems/belt/BeltDockOps.ts';
import type { BuildingComp } from '../src/game/components/BuildingComp.ts';
import { CELL_SIZE } from '../src/game/render/constants.ts';

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

/** 建一台最小 BuildingComp 设备（collectInputPortCells 只读 definitionId/direction）。 */
function placeBuilding(
  w: World, defId: string, gx: number, gy: number, direction: 0 | 90 | 180 | 270,
): void {
  const h = w.createEntity();
  w.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
  w.addComponent(h, 'BuildingComp', {
    definitionId: defId, direction, state: 'idle',
    bufferInput: [], bufferOutput: [], inputPollIndex: 0, outputPollQueue: [],
    currentRecipeId: null, progress: 0, elapsed: 0, paused: false,
  } as BuildingComp);
}

/** 精炼炉输入端口格索引（真实 PortCell 含 outward，与游戏内同一来源）。 */
function refiningPorts(direction: 0 | 90): Map<string, ReturnType<typeof inputPortCells>[number]> {
  const def = getBuildingDefinition('refining_unit')!;
  return new Map(inputPortCells(5, 5, def, direction).map((c) => [portKey(c), c]));
}

// ═══════════════════ collectInputPortCells ═══════════════════
console.log('[collectInputPortCells 端口格索引]');
{
  const w = new World();
  placeBuilding(w, 'refining_unit', 5, 5, 0);
  const ports = collectInputPortCells(w);
  assertEq(ports.size, 3, '1a. 精炼炉 0° 收录 3 个输入端口格');
  assert(['5,7', '6,7', '7,7'].every((k) => ports.has(k)),
    '1b. 输入端口格 = 底排 (5,7)(6,7)(7,7)');
  assert(!['5,5', '6,5', '7,5'].some((k) => ports.has(k)),
    '1c. 输出端口格（顶排）不收录');
  assert(!ports.has('5,6') && !ports.has('7,6'),
    '1d. 液体端口格（中间层）不收录');
  assert([...ports.values()].every((c) => c.outward === 90),
    '1e. 底排输入口 outward=90(下)——供给格在端口下方一格');
}
{
  const w = new World();
  placeBuilding(w, 'refining_unit', 5, 5, 90);
  const keys = [...collectInputPortCells(w).keys()].sort();
  assertEq(keys, ['5,5', '5,6', '5,7'], '2a. 精炼炉 90° → 左列 (5,5)(5,6)(5,7)');
  placeBuilding(w, 'refining_unit', 12, 5, 0);
  assertEq(collectInputPortCells(w).size, 6, '2b. 两台设备合并收录（互不覆盖）');
}

// ═══════════════════ dockRedirect 端口重定向 ═══════════════════
console.log('[dockRedirect 端口重定向]');
{
  // 0° 精炼炉: 底中输入口 (6,7) outward=90(下) → 朝向侧供给格 (6,8)
  const ports = refiningPorts(0);
  const r3 = dockRedirect({ x: 6, y: 7 }, ports);
  assertEq(r3, { target: { x: 6, y: 8 }, snap: { cell: { x: 6, y: 8 }, dir: 270 } },
    '3a. mouse 在端口格 (6,7) → 重定向供给格 (6,8)，末段吸附 270(上) 指向端口');

  assertEq(dockRedirect({ x: 6, y: 9 }, ports), null,
    '3b. mouse 在普通格 → null（不重定向）');
  assertEq(dockRedirect({ x: 6, y: 8 }, ports), null,
    '3c. mouse 在供给格（非端口格）→ null（重定向只在端口格触发）');

  // 90° 旋转: 左列输入口 (5,6) outward=180(左) → 供给格 (4,6)，吸附 0(右)
  const ports90 = refiningPorts(90);
  const r3d = dockRedirect({ x: 5, y: 6 }, ports90);
  assertEq(r3d, { target: { x: 4, y: 6 }, snap: { cell: { x: 4, y: 6 }, dir: 0 } },
    '3d. 90° 旋转设备: 端口格 (5,6) → 供给格 (4,6)，末段吸附 0(右) 指向端口');
}

// ═══════════════════ applySnapToCells 末格方向重放 ═══════════════════
console.log('[applySnapToCells 末格方向重放]');
{
  // 侧方进入（direction=0 右）与吸附方向 270(上) 成 90° 转角 → 覆盖
  const cells = [{ x: 6, y: 8, direction: 0 as const }];
  applySnapToCells(cells, { cell: { x: 6, y: 8 }, dir: 270 });
  assertEq(cells[0].direction, 270, '4a. 末格与吸附格重合（90° 转角）→ 方向覆盖为吸附方向');

  // 180° 折返防御: 末格自然方向 90(下) = opposite(270) → 不覆盖（U 形非法带型）
  const cells4 = [{ x: 6, y: 8, direction: 90 as const }];
  applySnapToCells(cells4, { cell: { x: 6, y: 8 }, dir: 270 });
  assertEq(cells4[0].direction, 90, '4b. 末格自然方向与吸附方向相反（180° 折返）→ 不写入');

  const cells4c = [{ x: 5, y: 5, direction: 90 as const }];
  applySnapToCells(cells4c, { cell: { x: 6, y: 8 }, dir: 270 });
  assertEq(cells4c[0].direction, 90, '4c. 末格与吸附格不重合 → 不写入');

  applySnapToCells(cells4c, null);
  assertEq(cells4c[0].direction, 90, '4d. snap=null → no-op');

  applySnapToCells([], { cell: { x: 6, y: 8 }, dir: 270 });
  assert(true, '4e. 空路径 → 安全 no-op');
}

// ═══════════════════ dockInfoOf 对接信息 ═══════════════════
console.log('[dockInfoOf 对接信息]');
{
  const ports = refiningPorts(0);
  // 供给格 (6,8) 末段 270(上) 指向端口 (6,7)，且 (6,8) 是 (6,7) 的朝向侧供给格
  const info = dockInfoOf({ x: 6, y: 8 }, 270, ports);
  assertEq(info.confirmed, [ports.get('6,7')],
    '5a. 朝向侧供给格 + 末段指向端口 → confirmed 命中该端口');

  // 侧向横穿: (7,7) 末段 180(左) 命中端口 (6,7)，但 (7,7) 不是其供给格
  const side = dockInfoOf({ x: 7, y: 7 }, 180, ports);
  assertEq(side.confirmed, [], '5b. 侧向横穿（末格非朝向侧供给格）→ 不确认');

  // 末段方向背离端口（无相邻命中）
  const away = dockInfoOf({ x: 6, y: 8 }, 90, ports);
  assertEq(away.confirmed, [], '5c. 末段方向背离端口 → confirmed 空');

  // 候选紫 targets 已按 2026-09-02 用户要求移除，只剩 confirmed
  assert(!('targets' in away), '5d. targets 候选字段已移除（仅 confirmed）');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
