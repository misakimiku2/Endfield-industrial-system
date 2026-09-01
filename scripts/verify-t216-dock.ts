// T2.16 验证: 传送带终点对接（输入端口格索引 / 供给格判定 / 末段方向吸附 / 对接信息）
// 依据: implementation-phase-2.md T2.16（2026-08-24 用户实测: 拖到设备格整条染红、
//       末段方向不指向端口时物品默默停在带尾——"连不上设备"无反馈）
//
// 用法: node --experimental-strip-types scripts/verify-t216-dock.ts
//
// 断言:
//   IntakeOps.collectInputPortCells（端口格权威索引）:
//     1. 精炼炉 0° → 底排 3 输入口；输出/液体口不收录
//     2. 精炼炉 90° → 左列；多台设备合并收录
//   BeltDockOps.dockTargetAt（供给格判定）:
//     3. 端口下方格 → dir=270(上)；左方格 → dir=180(右指)；对角/无邻 → null
//   BeltDockOps.applyDockSnap（终点吸附核心）:
//     4. mouse 在端口格上 → 路径截断到供给格 + 末段指向端口（拖到设备上也能对接）
//     5. mouse 在端口格上但路径仅 [起点, 端口格] → 不吸附（供给格=起点，无可落盘段）
//     6. mouse 在供给格上（侧面接近，默认尾向背离端口）→ 末段方向覆盖为指向端口
//     7. 吸附与进入方向 180° 折返（供给格/端口格两情形）→ 放弃吸附（U 形不是合法带型）
//     8. mouse 在普通格上 → 原样返回无吸附
//   BeltDockOps.applySnapToCells:
//     9. 末格与吸附格重合 → 覆盖方向；不重合 → 不写入
//  10. BeltDockOps.dockInfoOf: targets=末格四邻端口格；confirmed=末段方向命中的端口格
import { World } from '../src/game/ECS.ts';
import { BUILDING_DEFINITIONS } from '../src/game/data/buildings.ts';
import { collectInputPortCells } from '../src/game/systems/machine/IntakeOps.ts';
import {
  dockTargetAt,
  applyDockSnap,
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
}
{
  const w = new World();
  placeBuilding(w, 'refining_unit', 5, 5, 90);
  const keys = [...collectInputPortCells(w).keys()].sort();
  assertEq(keys, ['5,5', '5,6', '5,7'], '2a. 精炼炉 90° → 左列 (5,5)(5,6)(5,7)');
  placeBuilding(w, 'refining_unit', 12, 5, 0);
  assertEq(collectInputPortCells(w).size, 6, '2b. 两台设备合并收录（互不覆盖）');
}

// ═══════════════════ dockTargetAt 供给格判定 ═══════════════════
console.log('[dockTargetAt 供给格判定]');
{
  const ports = new Map([['6,7', { x: 6, y: 7 }]]);
  assertEq(dockTargetAt({ x: 6, y: 8 }, ports), { portCell: { x: 6, y: 7 }, dir: 270 },
    '3a. 端口下方格 (6,8) → 指向端口方向 270(上)');
  const portsLeft = new Map([['6,7', { x: 6, y: 7 }]]);
  const left = dockTargetAt({ x: 7, y: 7 }, portsLeft);
  assertEq(left, { portCell: { x: 6, y: 7 }, dir: 180 },
    '3b. 端口右方格 (7,7) → 指向端口方向 180(左)');
  assertEq(dockTargetAt({ x: 7, y: 8 }, portsLeft), null,
    '3c. 对角格 (7,8) → null（四邻才算供给格）');
  assertEq(dockTargetAt({ x: 0, y: 0 }, portsLeft), null,
    '3d. 无端口相邻的普通格 → null');
}

// ═══════════════════ applyDockSnap 终点吸附 ═══════════════════
console.log('[applyDockSnap 终点吸附]');
{
  // 布局: 端口格 (6,7)（如精炼炉底中输入口），供给格 (6,8)，带从 (6,10) 向上
  const ports = new Map([[portKey({ x: 6, y: 7 }), { x: 6, y: 7 }]]);
  const raw = [{ x: 6, y: 10 }, { x: 6, y: 9 }, { x: 6, y: 8 }, { x: 6, y: 7 }];

  // 4. mouse 在端口格上 → 截断 + 指向端口
  const r4 = applyDockSnap(raw, { x: 6, y: 7 }, ports, 270);
  assertEq(r4.raw, [{ x: 6, y: 10 }, { x: 6, y: 9 }, { x: 6, y: 8 }],
    '4a. mouse 在端口格 → 路径截断到供给格 (6,8)');
  assertEq(r4.snap, { cell: { x: 6, y: 8 }, dir: 270 },
    '4b. 吸附决策: 末段 (6,8) 方向 270(上) 指向端口 (6,7)');
  // 4c. 原数组不被原地修改（checkPathValid 用返回值，调用方无共享突变）
  assertEq(raw.length, 4, '4c. 截断产生新数组，入参 raw 不被修改');

  // 5. mouse 在端口格上但路径仅 [起点, 端口格] → 不吸附
  const r5 = applyDockSnap(
    [{ x: 6, y: 8 }, { x: 6, y: 7 }], { x: 6, y: 7 }, ports, 270,
  );
  assertEq(r5.snap, null, '5a. 供给格=起点格（无新段可落盘）→ 不吸附');
  assertEq(r5.raw.length, 2, '5b. 路径不截断（含端口格 → checkPathValid 染红提示）');

  // 6. mouse 在供给格上、侧面接近（默认尾向 ≠ 指向端口）→ 覆盖末段方向
  const ports6 = new Map([[portKey({ x: 0, y: 0 }), { x: 0, y: 0 }]]);
  const raw6 = [{ x: 1, y: -2 }, { x: 1, y: -1 }, { x: 1, y: 0 }];
  const r6 = applyDockSnap(raw6, { x: 1, y: 0 }, ports6, 90);
  assertEq(r6.raw.length, 3, '6a. mouse 在供给格 → 路径不截断');
  assertEq(r6.snap, { cell: { x: 1, y: 0 }, dir: 180 },
    '6b. 默认尾向 90(下) 被覆盖为 180(左) 指向端口 (0,0)——90° 合法转角');

  // 7a. 供给格情形 180° 折返 → 放弃吸附
  //     单格带: 起点在 (2,0) 出方向 0(右)，进入供给格 (1,0) 移动向右，
  //     端口 (0,0) 在供给格左侧 → 吸附方向 180 与进入方向 0 相反
  const ports7 = new Map([[portKey({ x: 0, y: 0 }), { x: 0, y: 0 }]]);
  const r7a = applyDockSnap([{ x: 2, y: 0 }, { x: 1, y: 0 }], { x: 1, y: 0 }, ports7, 0);
  assertEq(r7a.snap, null, '7a. 进入方向 0 与吸附方向 180 相反 → 不吸附（U 形非法带型）');

  // 7b. 端口格情形 180° 折返 → 放弃吸附且不截断
  const r7b = applyDockSnap(
    [{ x: 2, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }], { x: 0, y: 0 }, ports7, 0,
  );
  assertEq(r7b.snap, null, '7b1. 端口格截断情形同样拒绝 180° 折返');
  assertEq(r7b.raw.length, 3, '7b2. 路径保持原样（含端口格 → 染红）');

  // 8. mouse 在普通格上 → 原样无吸附
  const r8 = applyDockSnap(raw, { x: 6, y: 9 }, ports, 270);
  assertEq(r8.snap, null, '8a. mouse 在普通格（非端口/供给格）→ 不吸附');
  assertEq(r8.raw, raw, '8b. 路径原样返回');

  // 8c. 路径过短（mouse 在锚点上 raw=[锚点]）→ 不吸附不崩
  assertEq(applyDockSnap([{ x: 6, y: 8 }], { x: 6, y: 8 }, ports, 270).snap, null,
    '8c. 单点路径 → 不吸附');
}

// ═══════════════════ applySnapToCells / dockInfoOf ═══════════════════
console.log('[applySnapToCells 末格方向重放 + dockInfoOf 对接信息]');
{
  const cells = [{ x: 1, y: 0, direction: 90 as const }];
  applySnapToCells(cells, { cell: { x: 1, y: 0 }, dir: 180 });
  assertEq(cells[0].direction, 180, '9a. 末格与吸附格重合 → 方向覆盖为吸附方向');

  const cells9 = [{ x: 5, y: 5, direction: 90 as const }];
  applySnapToCells(cells9, { cell: { x: 1, y: 0 }, dir: 180 });
  assertEq(cells9[0].direction, 90, '9b. 末格与吸附格不重合 → 不写入');

  applySnapToCells(cells9, null);
  assertEq(cells9[0].direction, 90, '9c. snap=null → no-op');

  const ports = new Map([
    [portKey({ x: 6, y: 7 }), { x: 6, y: 7 }],
    [portKey({ x: 8, y: 7 }), { x: 8, y: 7 }],
  ]);
  const info = dockInfoOf({ x: 7, y: 7 }, 180, ports);
  assertEq(info.targets.length, 2, '10a. targets = 末格 (7,7) 四邻全部端口格（左+右）');
  assertEq(info.confirmed, [{ x: 6, y: 7 }], '10b. confirmed = 末段方向 180(左) 命中的 (6,7)');
  const info2 = dockInfoOf({ x: 7, y: 7 }, 0, ports);
  assertEq(info2.confirmed, [{ x: 8, y: 7 }], '10c. 末段方向 0(右) → confirmed=(8,7)');
  const info3 = dockInfoOf({ x: 7, y: 7 }, 90, ports);
  assertEq(info3.confirmed, [], '10d. 末段方向 90(下，无端口) → confirmed 空（仅候选）');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
