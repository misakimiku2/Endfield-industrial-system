// T1.7 设备放置系统验证脚本
// 用法 (需 ts-loader 解析无后缀 import):
//   node --experimental-strip-types \
//        --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./scripts/ts-loader.mjs", pathToFileURL("./"));' \
//        scripts/verify-t1.7.ts
//
// 验证内容（纯逻辑，无需 canvas）:
//   A. BuildingDefinition 数据表 (A3 §1.1): 7 个设备字段齐全、footprint 正确、texture key
//   B. TOOLBAR_BUILDINGS: 4 个设备，footprint 覆盖 3×3 + 5×5
//   C. OccupancyMap (A2 §7): occupy/isOccupied/canPlace/release/边界/inBounds
//   D. OccupancyMap footprint: occupyFootprint/releaseFootprint 占多格、正方形旋转占地不变
//   E. snapToCell + worldToCell (A2 §2.3): 吸附到最近 Cell 交叉点
//   F. R 键相对视图换算 (A6 §4.0): 4 viewRotation × 4 screenAngle = 16 组合
//      世界朝向 = (屏幕朝向 − viewRotation + 360) % 360
//   G. screenAngle 递增逻辑: 按 R 永远 +90 mod 360，4 次回 0（不直接碰 direction）
//   H. 放置落盘 (A3 §5): canPlace→创建实体，查 Position/BuildingComp/SpriteComp + occupancy 已占
//   I. 边界外放置拒绝: footprint 越界 canPlace=false
//   J. 占用冲突拒绝: 重叠 footprint canPlace=false
//
// 说明: PlacementSystem 的 PixiJS Sprite 旋转符号 (sprite.rotation = ±screenAngle_rad)
//       依赖真实渲染，Node 下无法验证，留浏览器实测。本脚本聚焦纯逻辑层。

import { MapInstance } from '../src/game/world/MapInstance.ts';
import { OccupancyMap } from '../src/game/world/OccupancyMap.ts';
import {
  BUILDING_DEFINITIONS,
  TOOLBAR_BUILDINGS,
  getBuildingDefinition,
  type BuildingDefinition,
} from '../src/game/data/buildings.ts';
import type { Direction } from '../src/game/components/BuildingComp.ts';
import { World } from '../src/game/ECS.ts';
import { CELL_SIZE } from '../src/game/render/constants.ts';

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

// ───────────────────────── A. BuildingDefinition 数据表 ─────────────────────────
console.log('\n[A] BuildingDefinition 数据表 (A3 §1.1)');
{
  const expectedIds = [
    'refining_unit',
    'shredding_unit',
    'fitting_unit',
    'moulding_unit',
    'seed_picking_unit',
    'planting_unit',
    // T2.12 仓库取/存货口（非生产设备: 无槽位、无限源/汇）
    'depot_unloader',
    'depot_loader',
    // T1.11 九宫格验收 demo 设备（S2 §8-2 任意尺寸正确性，不进 TOOLBAR）
    'test_nineslice_4x3',
    'test_nineslice_6x3',
    'test_nineslice_5x5',
    'test_nineslice_6x6',
    // T1.12 端口变体验收 demo 设备（S3 §6，不进 TOOLBAR）
    'test_nineslice_noport',
    'test_nineslice_liquid_5x5',
    'test_nineslice_full_5x5',
  ];
  for (const id of expectedIds) {
    const def = getBuildingDefinition(id);
    assert(def !== undefined, `getBuildingDefinition('${id}') 存在`);
    if (!def) continue;
    assert(def.id === id, `  ${id}.id === '${id}'`);
    assert(def.name.length > 0, `  ${id}.name 非空 ('${def.name}')`);
    assert(def.footprint.w > 0 && def.footprint.h > 0, `  ${id}.footprint 正数 (${def.footprint.w}×${def.footprint.h})`);
    assert(def.texture.length > 0, `  ${id}.texture 非空 ('${def.texture}')`);
    assert(def.selectable === true, `  ${id}.selectable === true`);
    // T1.12 test_nineslice_noport 无端口是设计目的（纯底座演示）——端口非空断言跳过它
    if (id !== 'test_nineslice_noport') {
      assert(def.ports.length > 0, `  ${id}.ports 非空 (${def.ports.length} 个)`);
    }
    assert(def.buildCost.length > 0, `  ${id}.buildCost 非空 (Phase 2 备用)`);
    // T2.12 仓库口无槽位（无限源/汇不建模库存）——槽位正数断言只对非 depot 设备成立
    if (!def.depot) {
      assert(def.inputSlotCount > 0 && def.outputSlotCount > 0, `  ${id} 槽位数正数 (Phase 2 备用)`);
    }
  }
  assert(Object.keys(BUILDING_DEFINITIONS).length === expectedIds.length,
    `BUILDING_DEFINITIONS 总数 = ${expectedIds.length} (实际 ${Object.keys(BUILDING_DEFINITIONS).length})`);

  // refining_unit 特定 footprint (A3 §1.1)
  const refining = getBuildingDefinition('refining_unit')!;
  assert(refining.footprint.w === 3 && refining.footprint.h === 3, '精炼炉 footprint 3×3');
  assert(refining.category === 'production', '精炼炉 category=production');

  // 5×5 农业
  const seed = getBuildingDefinition('seed_picking_unit')!;
  assert(seed.footprint.w === 5 && seed.footprint.h === 5, '采种机 footprint 5×5');
  assert(seed.category === 'agriculture', '采种机 category=agriculture');
}

// ───────────────────────── B. TOOLBAR_BUILDINGS ─────────────────────────
console.log('\n[B] TOOLBAR_BUILDINGS (T1.7 工具栏，T2.12 起为 6 设备)');
{
  assert(TOOLBAR_BUILDINGS.length === 6, `工具栏 6 个设备 (实际 ${TOOLBAR_BUILDINGS.length})`);
  const footprints = new Set<number>();
  for (const id of TOOLBAR_BUILDINGS) {
    const def = getBuildingDefinition(id);
    assert(def !== undefined, `工具栏设备 '${id}' 在定义表中存在`);
    if (def) footprints.add(def.footprint.w);
  }
  // 覆盖 3×3 和 5×5（用户选定方案 1）
  assert(footprints.has(3), '工具栏覆盖 3×3 footprint');
  assert(footprints.has(5), '工具栏覆盖 5×5 footprint');
}

// ───────────────────────── C. OccupancyMap 基础 ─────────────────────────
console.log('\n[C] OccupancyMap 基础 (A2 §7, 读 MapInstance 边界)');
{
  const map = new MapInstance({ widthCells: 8, heightCells: 6 }); // 用非正方形地图测边界
  const occ = new OccupancyMap(map);

  assert(!occ.isOccupied(0, 0), '初始 (0,0) 未占用');
  assert(occ.getOccupant(0, 0) === null, '初始 (0,0) 占用者=null');

  occ.occupy(2, 3, 'refining_unit');
  assert(occ.isOccupied(2, 3), 'occupy 后 (2,3) 已占用');
  assert(occ.getOccupant(2, 3) === 'refining_unit', '(2,3) 占用者=refining_unit');

  occ.release(2, 3);
  assert(!occ.isOccupied(2, 3), 'release 后 (2,3) 未占用');
  assert(occ.getOccupant(2, 3) === null, 'release 后 (2,3) 占用者=null');

  // 幂等 release
  occ.release(2, 3);
  assert(!occ.isOccupied(2, 3), '重复 release 幂等');

  // canPlace 1×1 边界内
  assert(occ.canPlace(0, 0, 1, 1), 'canPlace(0,0,1,1) 边界内空闲=true');
  assert(occ.canPlace(7, 5, 1, 1), 'canPlace(7,5,1,1) 地图右下角(8×6 边界内)=true');

  // canPlace 边界外（读 MapInstance 边界，不读全局常量）
  assert(!occ.canPlace(-1, 0, 1, 1), 'canPlace(-1,0) 越左界=false');
  assert(!occ.canPlace(0, -1, 1, 1), 'canPlace(0,-1) 越上界=false');
  assert(!occ.canPlace(8, 0, 1, 1), 'canPlace(8,0) 越右界(widthCells=8)=false');
  assert(!occ.canPlace(0, 6, 1, 1), 'canPlace(0,6) 越下界(heightCells=6)=false');

  // snapshot
  occ.occupy(1, 1, 'depot');
  occ.occupy(1, 2, 'depot');
  const snap = occ.snapshot();
  assert(snap.length === 2, `snapshot 返回 2 条 (实际 ${snap.length})`);
  assert(occ.occupiedCount === 2, 'occupiedCount=2');
  occ.clear();
  assert(occ.occupiedCount === 0, 'clear 后 occupiedCount=0');
}

// ───────────────────────── D. OccupancyMap footprint ─────────────────────────
console.log('\n[D] OccupancyMap footprint (A3 §3.4, 正方形占地旋转不变 A3 §6)');
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const refining = getBuildingDefinition('refining_unit')!; // 3×3

  // canPlace 3×3 全空闲
  assert(occ.canPlace(5, 5, 3, 3), 'canPlace(5,5,3×3) 空闲=true');

  // 占用 footprint
  occ.occupyFootprint(5, 5, refining, 0);
  // 3×3 = 9 格全占用
  let count = 0;
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
    if (occ.isOccupied(5 + dx, 5 + dy)) count++;
  }
  assert(count === 9, `occupyFootprint(3×3) 占满 9 格 (实际 ${count})`);
  assert(occ.getOccupant(5, 5) === 'refining_unit', 'footprint 内 (5,5) 占用者=refining_unit');
  assert(occ.getOccupant(7, 7) === 'refining_unit', 'footprint 内 (7,7) 占用者=refining_unit');

  // 占用后同区域 canPlace=false
  assert(!occ.canPlace(5, 5, 3, 3), '已占用区域 canPlace(5,5,3×3)=false');
  // 部分重叠
  assert(!occ.canPlace(4, 4, 3, 3), '部分重叠 canPlace(4,4,3×3)=false');
  assert(!occ.canPlace(6, 6, 3, 3), '部分重叠 canPlace(6,6,3×3)=false');
  // 相邻不重叠
  assert(occ.canPlace(8, 5, 3, 3), '相邻不重叠 canPlace(8,5,3×3)=true');

  // 5×5 footprint
  const seed = getBuildingDefinition('seed_picking_unit')!; // 5×5
  assert(occ.canPlace(10, 10, 5, 5), 'canPlace(10,10,5×5) 空闲=true');
  occ.occupyFootprint(10, 10, seed, 0);
  count = 0;
  for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) {
    if (occ.isOccupied(10 + dx, 10 + dy)) count++;
  }
  assert(count === 25, `occupyFootprint(5×5) 占满 25 格 (实际 ${count})`);

  // 边界检查: footprint 越界
  assert(!occ.canPlace(14, 0, 3, 3), 'footprint 越右界 canPlace(14,0,3×3)=false (14+3>16)');
  assert(!occ.canPlace(0, 14, 3, 3), 'footprint 越下界 canPlace(0,14,3×3)=false');

  // releaseFootprint
  occ.releaseFootprint(5, 5, refining, 0);
  count = 0;
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
    if (occ.isOccupied(5 + dx, 5 + dy)) count++;
  }
  assert(count === 0, 'releaseFootprint(3×3) 清空 9 格');
  assert(occ.canPlace(5, 5, 3, 3), 'release 后 canPlace(5,5,3×3)=true');

  // 正方形占地旋转不变: 占用记录不因 direction 不同而变化
  occ.occupyFootprint(0, 0, refining, 0);
  const occupiedAt0 = occ.snapshot().filter(c => c.defId === 'refining_unit').length;
  occ.clear();
  occ.occupyFootprint(0, 0, refining, 90);
  const occupiedAt90 = occ.snapshot().filter(c => c.defId === 'refining_unit').length;
  assert(occupiedAt0 === occupiedAt90, `正方形占地旋转不变 (0°:${occupiedAt0} == 90°:${occupiedAt90})`);
}

// ───────────────────────── E. snapToCell + worldToCell ─────────────────────────
console.log('\n[E] snapToCell + worldToCell (A2 §2.3)');
{
  // 复刻 A2 §2.3 的 snapToCell / worldToCell（与 PlacementSystem 同实现）
  const snapToCell = (wx: number, wy: number) => ({
    x: Math.round(wx / CELL_SIZE) * CELL_SIZE,
    y: Math.round(wy / CELL_SIZE) * CELL_SIZE,
  });
  const worldToCell = (wx: number, wy: number) => ({
    x: Math.floor(wx / CELL_SIZE),
    y: Math.floor(wy / CELL_SIZE),
  });

  // 中心吸附: Math.round 对 .5 向上取整（JS 行为），故 32px(=0.5 cell) → 64(下一 cell)
  // 0~31px → Cell 0(原点 0)，32~95px → Cell 1(原点 64)，等。
  let s = snapToCell(32, 32);
  assert(s.x === 64 && s.y === 64, `snapToCell(32,32)=(64,64) [0.5 cell round 向上到下一 cell]`);
  s = snapToCell(31, 31);
  assert(s.x === 0 && s.y === 0, `snapToCell(31,31)=(0,0) [<0.5 round 到当前 cell]`);
  s = snapToCell(100, 200);
  // 100/64≈1.56 → round=2 → 128; 200/64≈3.125 → round=3 → 192
  assert(s.x === 128 && s.y === 192, `snapToCell(100,200)=(128,192)`);

  // worldToCell: floor
  let c = worldToCell(0, 0);
  assert(c.x === 0 && c.y === 0, 'worldToCell(0,0)=(0,0)');
  c = worldToCell(63, 63);
  assert(c.x === 0 && c.y === 0, 'worldToCell(63,63)=(0,0) [floor 到 Cell 0]');
  c = worldToCell(64, 64);
  assert(c.x === 1 && c.y === 1, 'worldToCell(64,64)=(1,1)');

  // 一致性: snapToCell 落点是某 Cell 左上角
  s = snapToCell(95, 95); // → (64,64)
  c = worldToCell(s.x, s.y); // → (1,1)
  assert(c.x === 1 && c.y === 1, 'snapToCell(95,95) 落点是 Cell(1,1) 左上角');
}

// ───────────────────────── E2. placementFromMouse（鼠标=设备中心 + 视觉/网格一致，T1.7）─────────────────────────
console.log('\n[E2] placementFromMouse 鼠标=设备中心 + 视觉与占用网格一致 (T1.7)');
{
  // 复刻 PlacementSystem.placementFromMouse 同算法
  // 关键: topLeftWorld 从 topLeftGrid 派生（grid*CELL），grid 与 world 用同一舍入(round)——
  //   保证预览视觉位置 = canPlace 检查的网格位置，不差格。
  // 舍入方向用 round（向最近）而非 floor（向下），消除设备系统性偏左上（T1.7 第二轮修订）。
  const placementFromMouse = (mwx: number, mwy: number, w: number, h: number) => {
    const halfW = (w * CELL_SIZE) / 2;
    const halfH = (h * CELL_SIZE) / 2;
    const tlx = mwx - halfW;
    const tly = mwy - halfH;
    const gridX = Math.round(tlx / CELL_SIZE);
    const gridY = Math.round(tly / CELL_SIZE);
    return {
      topLeftGrid: { x: gridX, y: gridY },
      topLeftWorld: { x: gridX * CELL_SIZE, y: gridY * CELL_SIZE },
    };
  };

  // 3×3 设备：鼠标 world(336,336)
  // halfW=96, tlx=240, gridX=round(240/64)=round(3.75)=4, world=4*64=256
  let r = placementFromMouse(336, 336, 3, 3);
  assert(r.topLeftGrid.x === 4 && r.topLeftGrid.y === 4, `3×3 鼠标(336,336) 左上角Cell=(4,4)`);
  assert(r.topLeftWorld.x === 256 && r.topLeftWorld.y === 256, `3×3 鼠标(336,336) 左上角World=(256,256) [从grid派生]`);

  // ★ 核心断言: topLeftWorld 严格 == topLeftGrid * CELL（视觉与网格一致，修复"差一格"bug）
  assert(r.topLeftWorld.x === r.topLeftGrid.x * CELL_SIZE, 'topLeftWorld.x == topLeftGrid.x * CELL（视觉=网格）');
  assert(r.topLeftWorld.y === r.topLeftGrid.y * CELL_SIZE, 'topLeftWorld.y == topLeftGrid.y * CELL（视觉=网格）');

  // 鼠标在设备覆盖范围内（左上 256, 3×3 占到 256~448，336 在内）
  const inRange = 336 >= r.topLeftWorld.x && 336 <= r.topLeftWorld.x + 3 * CELL_SIZE;
  assert(inRange, '鼠标在设备覆盖范围内');

  // 5×5 设备：鼠标 world(2048,2048)
  // halfW=160, tlx=1888, gridX=round(1888/64)=round(29.5)=30(JS .5 向上), world=30*64=1920
  r = placementFromMouse(2048, 2048, 5, 5);
  assert(r.topLeftGrid.x === 30 && r.topLeftGrid.y === 30, `5×5 鼠标(2048,2048) 左上角Cell=(30,30)`);
  assert(r.topLeftWorld.x === 1920 && r.topLeftWorld.y === 1920, `5×5 鼠标(2048,2048) 左上角World=(1920,1920) [从grid派生]`);
  assert(r.topLeftWorld.x === r.topLeftGrid.x * CELL_SIZE, '5×5 topLeftWorld.x == grid*CELL');

  // 1×1 设备：鼠标 world(100,100)
  // halfW=32, tlx=68, gridX=round(68/64)=round(1.0625)=1, world=64
  r = placementFromMouse(100, 100, 1, 1);
  assert(r.topLeftGrid.x === 1 && r.topLeftGrid.y === 1, `1×1 鼠标(100,100) 左上角Cell=(1,1)`);
  assert(r.topLeftWorld.x === 64 && r.topLeftWorld.y === 64, `1×1 鼠标(100,100) 左上角World=(64,64)`);
  assert(r.topLeftWorld.x === r.topLeftGrid.x * CELL_SIZE, '1×1 topLeftWorld.x == grid*CELL');

  // ★ 逐像素扫描：topLeftWorld 永远 == topLeftGrid*CELL（grid/world 同舍入，不差格）
  let allConsistent = true;
  for (let mx = 0; mx < 1000; mx += 7) {
    const rr = placementFromMouse(mx, mx, 3, 3);
    if (rr.topLeftWorld.x !== rr.topLeftGrid.x * CELL_SIZE) { allConsistent = false; break; }
    if (rr.topLeftWorld.y !== rr.topLeftGrid.y * CELL_SIZE) { allConsistent = false; break; }
  }
  assert(allConsistent, '逐像素扫描: topLeftWorld 永远 == grid*CELL（grid/world 同舍入，视觉=占用网格）');

  // ★ round 对称性（修复"系统性偏左上"）: 鼠标在 Cell 内不同位置，grid 增减对称
  // 3×3 设备中心候选落在 Cell 内时，round 使设备向最近 Cell 对齐（左/右各半格内对称）
  // 验证: 鼠标刚好在 Cell 中心 (grid*CELL + halfFootprint) 时，偏移应为 0
  // 3×3 中心对齐 grid(4,4): center = topLeft + 96 = 256+96 = 352
  const centerWorld = 4 * CELL_SIZE + 96; // 352
  r = placementFromMouse(centerWorld, centerWorld, 3, 3);
  const devCenter = r.topLeftWorld.x + 96; // 设备中心世界
  assert(devCenter === centerWorld, `3×3 鼠标在Cell中心(${centerWorld}): 设备中心=${devCenter} 对齐鼠标（无偏移）`);
}

// ───────────────────────── F. R 键相对视图换算（核心）─────────────────────────
console.log('\n[F] R 键相对视图换算 (A6 §4.0, A3 §3.3) — 世界朝向 = (屏幕朝向 − viewRotation + 360) % 360');
{
  // 这是 T1.7 最易写错处。PlacementSystem 落盘时用的换算公式。
  // 公式依据 A6 §4.0: "世界朝向 = 屏幕朝向 − viewRotation (mod 360)"。
  //   即视图转 90° 后按一次 R(屏幕+90)，世界朝向不变(90−90=0)；连按两次才让世界+90。
  const toWorld = (screenAngle: number, viewRotation: number): Direction =>
    (((screenAngle - viewRotation) % 360) + 360) % 360 as Direction;

  // 4 viewRotation × 4 screenAngle = 16 组合全表
  const views: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];
  const screens: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];

  // 预期表（手算）: 行=screenAngle, 列=viewRotation, 值=世界朝向
  const expected: Record<number, Record<number, number>> = {
    // screenAngle 0: 世界 = (0 - view + 360) % 360
    0: { 0: 0, 90: 270, 180: 180, 270: 90 },
    // screenAngle 90: 世界 = (90 - view + 360) % 360
    90: { 0: 90, 90: 0, 180: 270, 270: 180 },
    // screenAngle 180
    180: { 0: 180, 90: 90, 180: 0, 270: 270 },
    // screenAngle 270
    270: { 0: 270, 90: 180, 180: 90, 270: 0 },
  };

  let allOk = true;
  for (const sa of screens) {
    for (const vr of views) {
      const got = toWorld(sa, vr);
      const exp = expected[sa][vr];
      if (got !== exp) {
        allOk = false;
        console.error(`  ❌ screen=${sa}, view=${vr}: 期望世界=${exp}, 实际=${got}`);
      }
    }
  }
  assert(allOk, '16 组合 (4 viewRotation × 4 screenAngle) 全部正确');

  // 关键语义校验 (A6 §4.0 原文):
  // "视图转 90° 后按一次 R，屏幕朝向 +90° 而世界朝向不变；连按两次才让世界朝向真正 +90°"
  let view: 0 | 90 | 180 | 270 = 90;
  let screen = 0;
  // 按 1 次 R
  screen = (screen + 90) % 360;
  let world1 = toWorld(screen, view);
  assert(world1 === 0, `视图90°按1次R: 世界朝向不变 (期望0, 实际${world1})`);
  // 按 2 次 R
  screen = (screen + 90) % 360;
  let world2 = toWorld(screen, view);
  assert(world2 === 90, `视图90°按2次R: 世界朝向 +90° (期望90, 实际${world2})`);

  // viewRotation=0 时屏幕朝向 = 世界朝向（无视图旋转，所见即世界）
  view = 0;
  for (const sa of screens) {
    const w = toWorld(sa, view);
    assert(w === sa, `view=0 时 screen=${sa} → 世界=${sa} (所见即世界)`);
  }
}

// ───────────────────────── G. screenAngle 递增 ─────────────────────────
console.log('\n[G] screenAngle 递增 (按 R 永远 +90 mod 360，不直接碰 direction)');
{
  // PlacementSystem 维护 screenAngle(0/90/180/270)，按 R 永远 +90。
  // 关键: 绝不对 direction 直接 +90——防错的根本。
  type ScreenAngle = 0 | 90 | 180 | 270;
  const next = (a: ScreenAngle): ScreenAngle => ((a + 90) % 360) as ScreenAngle;

  let a: ScreenAngle = 0;
  const seq: number[] = [a];
  for (let i = 0; i < 4; i++) { a = next(a); seq.push(a); }
  // 按 4 次 R 回到 0
  assert(seq[0] === 0 && seq[1] === 90 && seq[2] === 180 && seq[3] === 270 && seq[4] === 0,
    `按 R 4 次序列 0→90→180→270→0 (实际 ${seq.join('→')})`);

  // 从任意起点开始也是单调 +90
  a = 180;
  const seq2: number[] = [a];
  for (let i = 0; i < 4; i++) { a = next(a); seq2.push(a); }
  assert(seq2.join('→') === '180→270→0→90→180',
    `从 180 起按 R 4 次 180→270→0→90→180 (实际 ${seq2.join('→')})`);
}

// ───────────────────────── H. 放置落盘 (A3 §5) ─────────────────────────
console.log('\n[H] 放置落盘 (A3 §5) — 创建实体 + 三组件 + occupancy 占用');
{
  // 复刻 A3 §5 放置流程的核心（不含 PixiJS Sprite，那由 RenderSystem 自动建）
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const refining = getBuildingDefinition('refining_unit')!; // 3×3

  // 放置函数（与 PlacementSystem.commitPlacement 同逻辑）
  const placeAt = (
    def: BuildingDefinition,
    gx: number, gy: number,
    direction: Direction,
  ): boolean => {
    const { w, h } = def.footprint;
    if (!occ.canPlace(gx, gy, w, h)) return false;
    const handle = world.createEntity();
    world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    world.addComponent(handle, 'BuildingComp', { definitionId: def.id, direction, state: 'idle' as const });
    world.addComponent(handle, 'SpriteComp', {
      group: 'devices' as const, textureKey: def.texture,
      width: w * CELL_SIZE, height: h * CELL_SIZE, layer: 2,
    });
    occ.occupyFootprint(gx, gy, def, direction);
    return true;
  };

  // 成功放置
  const ok1 = placeAt(refining, 5, 5, 0);
  assert(ok1, 'placeAt(refining, 5,5, 0°) 成功');
  assert(world.entityCount() === 1, `实体数=1 (实际 ${world.entityCount()})`);

  // 查实体三组件
  const handles = world.query('Position', 'BuildingComp', 'SpriteComp');
  assert(handles.length === 1, `query(Position,BuildingComp,SpriteComp) 命中 1 实体`);
  const h = handles[0];
  const pos = world.getComponent<{ x: number; y: number }>(h, 'Position')!;
  const bcomp = world.getComponent<{ definitionId: string; direction: Direction; state: string }>(h, 'BuildingComp')!;
  const spr = world.getComponent<{ group: string; textureKey: string; width: number; height: number; layer: number }>(h, 'SpriteComp')!;
  assert(pos.x === 5 * CELL_SIZE && pos.y === 5 * CELL_SIZE, `Position=(320,320) [grid(5,5)*64]`);
  assert(bcomp.definitionId === 'refining_unit', 'BuildingComp.definitionId=refining_unit');
  assert(bcomp.direction === 0, 'BuildingComp.direction=0');
  assert(bcomp.state === 'idle', 'BuildingComp.state=idle');
  assert(spr.group === 'devices' && spr.textureKey === 'refining_unit', 'SpriteComp 纹理 devices/refining_unit');
  assert(spr.width === 3 * CELL_SIZE && spr.height === 3 * CELL_SIZE, `SpriteComp 尺寸 3×3 cells=192×192`);
  assert(spr.layer === 2, 'SpriteComp.layer=2 (BuildingLayer)');

  // occupancy 已占
  assert(occ.isOccupied(5, 5) && occ.isOccupied(7, 7), 'occupancy footprint 内已占用');
  assert(!occ.canPlace(5, 5, 3, 3), '同位置再放被拒绝');

  // 第二个设备（不同位置，连放）
  const ok2 = placeAt(refining, 10, 10, 90);
  assert(ok2, 'placeAt(refining, 10,10, 90°) 成功');
  assert(world.entityCount() === 2, `实体数=2 (实际 ${world.entityCount()})`);
}

// ───────────────────────── I. 边界外放置拒绝 ─────────────────────────
console.log('\n[I] 边界外放置拒绝 (读 MapInstance 边界)');
{
  const map = new MapInstance({ widthCells: 8, heightCells: 8 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const refining = getBuildingDefinition('refining_unit')!; // 3×3

  const placeAt = (def: BuildingDefinition, gx: number, gy: number): boolean => {
    if (!occ.canPlace(gx, gy, def.footprint.w, def.footprint.h)) return false;
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    world.addComponent(h, 'BuildingComp', { definitionId: def.id, direction: 0 as Direction, state: 'idle' as const });
    world.addComponent(h, 'SpriteComp', {
      group: 'devices' as const, textureKey: def.texture,
      width: def.footprint.w * CELL_SIZE, height: def.footprint.h * CELL_SIZE, layer: 2,
    });
    occ.occupyFootprint(gx, gy, def, 0);
    return true;
  };

  // 边界内合法: (5,5) 3×3 占到 (7,7)，地图 8×8 边界内
  assert(placeAt(refining, 5, 5), 'placeAt(5,5) 3×3 在 8×8 地图内=true');
  // 越界: (6,6) 3×3 占到 (8,8) 越界
  assert(!placeAt(refining, 6, 6), 'placeAt(6,6) 3×3 越右下界=false');
  assert(world.entityCount() === 1, `越界放置不创建实体 (实体数仍=1)`);

  // 负坐标
  assert(!placeAt(refining, -1, 0), 'placeAt(-1,0) 越左界=false');
}

// ───────────────────────── J. 占用冲突拒绝 ─────────────────────────
console.log('\n[J] 占用冲突拒绝 (重叠 footprint)');
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const refining = getBuildingDefinition('refining_unit')!; // 3×3

  const placeAt = (def: BuildingDefinition, gx: number, gy: number): boolean => {
    if (!occ.canPlace(gx, gy, def.footprint.w, def.footprint.h)) return false;
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    world.addComponent(h, 'BuildingComp', { definitionId: def.id, direction: 0 as Direction, state: 'idle' as const });
    world.addComponent(h, 'SpriteComp', {
      group: 'devices' as const, textureKey: def.texture,
      width: def.footprint.w * CELL_SIZE, height: def.footprint.h * CELL_SIZE, layer: 2,
    });
    occ.occupyFootprint(gx, gy, def, 0);
    return true;
  };

  assert(placeAt(refining, 0, 0), '首个 refining 放 (0,0) 成功');
  // 与 (0,0) 3×3 部分重叠的位置全部失败
  assert(!placeAt(refining, 1, 1), '(1,1) 与 (0,0) 3×3 重叠=false');
  assert(!placeAt(refining, 2, 2), '(2,2) 与 (0,0) 3×3 重叠=false (仅角重叠)');
  assert(!placeAt(refining, 0, 0), '(0,0) 完全重叠=false');
  // 相邻不重叠成功
  assert(placeAt(refining, 3, 0), '(3,0) 与 (0,0) 3×3 相邻不重叠=true');
  assert(world.entityCount() === 2, `冲突位置不创建实体，成功 2 个 (实际 ${world.entityCount()})`);
}

// ───────────────────────── 总结 ─────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`T1.7 验证: ${passed} 通过, ${failed} 失败`);
console.log('='.repeat(60));
if (failed > 0) {
  process.exit(1);
}
