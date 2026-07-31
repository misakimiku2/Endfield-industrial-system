// T1.8 基础交互系统验证脚本
// 用法 (需 ts-loader 解析无后缀 import):
//   node --experimental-strip-types \
//        --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./scripts/ts-loader.mjs", pathToFileURL("./"));' \
//        scripts/verify-t1.8.ts
//
// 验证内容（纯逻辑 + headless PixiJS Container/Graphics，无需浏览器）:
//   A. pickBuildingAt 命中测试 (A3 §1 selectable + footprint AABB):
//      命中 footprint 内部/边界、未命中空白、selectable=false 跳过、非 BuildingComp 实体不参与
//   B. SelectionSystem 状态机 (T1.8 前瞻约束):
//      pointerdown 记录 → pointerup 短按(<300ms) 选中/取消、长按(≥300ms) 不改变选中、
//      点空白取消、切选另一设备、销毁实体后 update 清空选中态
//   C. buildingScreenPolygon 选中框投影 (A6 §4):
//      zoom=1/2、viewRotation=0/90 下四角 = worldToScreen 投影，框随相机缩放
//   D. 选中框 Graphics 生命周期: 未选中隐藏 → 选中可见 → clearSelection 隐藏
//
// 说明: 选中框的像素观感（白线 2px + 深色外描边、无模糊）依赖真实渲染，留浏览器实测。
//       本脚本聚焦纯逻辑层与几何投影。

import { Container, Graphics } from 'pixi.js';
import { World } from '../src/game/ECS.ts';
import { Camera } from '../src/game/render/Camera.ts';
import type { SceneLayers } from '../src/game/render/SceneRenderer.ts';
import {
  SelectionSystem,
  pickBuildingAt,
  buildingScreenPolygon,
  SELECTION_SHORT_PRESS_MS,
} from '../src/game/systems/SelectionSystem.ts';
import { getBuildingDefinition, type BuildingDefinition } from '../src/game/data/buildings.ts';
import type { Direction } from '../src/game/components/BuildingComp.ts';
import { MapInstance } from '../src/game/world/MapInstance.ts';
import { OccupancyMap } from '../src/game/world/OccupancyMap.ts';
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

/** 构造最小 SceneLayers（选中系统只用到 overlayLayer）。 */
function makeLayers(): SceneLayers {
  const worldContainer = new Container({ label: 'world' });
  const layer0Terrain = new Container({ label: 'terrain' });
  const layer1Grid = new Container({ label: 'grid' });
  const layer2Building = new Container({ label: 'building' });
  const layer3Item = new Container({ label: 'item' });
  const layer4Enemy = new Container({ label: 'enemy' });
  const layer5Effect = new Container({ label: 'effect' });
  worldContainer.addChild(
    layer0Terrain, layer1Grid, layer2Building, layer3Item, layer4Enemy, layer5Effect,
  );
  return {
    backgroundLayer: new Container({ label: 'background' }),
    worldContainer,
    layer0Terrain,
    layer1Grid,
    layer2Building,
    layer3Item,
    layer4Enemy,
    layer5Effect,
    overlayLayer: new Container({ label: 'overlay' }),
  };
}

/** 程序化放置一个设备（实体 + 占用表），返回 handle。 */
function placeBuilding(
  world: World,
  occ: OccupancyMap,
  def: BuildingDefinition,
  gx: number,
  gy: number,
): ReturnType<World['createEntity']> {
  if (!occ.canPlace(gx, gy, def.footprint.w, def.footprint.h)) {
    throw new Error(`placeBuilding: (${gx},${gy}) ${def.id} 无法放置`);
  }
  const h = world.createEntity();
  world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
  world.addComponent(h, 'BuildingComp', {
    definitionId: def.id, direction: 0 as Direction, state: 'idle' as const,
  });
  world.addComponent(h, 'SpriteComp', {
    group: 'devices' as const, textureKey: def.texture,
    width: def.footprint.w * CELL_SIZE, height: def.footprint.h * CELL_SIZE, layer: 2,
  });
  occ.occupyFootprint(gx, gy, def, 0);
  return h;
}

// ───────────────────────── A. pickBuildingAt 命中测试 ─────────────────────────
console.log('\n[A] pickBuildingAt 命中测试 (footprint AABB + selectable)');
let refiningA: EntityHandleLike;
let shreddingB: EntityHandleLike;
let pickWorld: World;
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  pickWorld = new World();
  const refining = getBuildingDefinition('refining_unit')!; // 3×3
  const shredding = getBuildingDefinition('shredding_unit')!; // 3×3

  // 精炼炉 (5,5): 世界矩形 [320,512)²
  refiningA = placeBuilding(pickWorld, occ, refining, 5, 5);
  // 粉碎机 (0,0): 世界矩形 [0,192)²
  shreddingB = placeBuilding(pickWorld, occ, shredding, 0, 0);

  assert(pickBuildingAt(pickWorld, 416, 416) === refiningA, '命中精炼炉中心 (416,416) → refining handle');
  assert(pickBuildingAt(pickWorld, 320, 320) === refiningA, '命中精炼炉左上角边界 (320,320)（含边界）');
  assert(pickBuildingAt(pickWorld, 511, 511) === refiningA, '命中精炼炉右下角边界 (511,511)（含边界）');
  assert(pickBuildingAt(pickWorld, 319, 319) === null, '(319,319) 精炼炉外 → null');
  assert(pickBuildingAt(pickWorld, 100, 100) === shreddingB, '命中粉碎机内部 (100,100) → shredding handle');
  assert(pickBuildingAt(pickWorld, 600, 600) === null, '空白区域 (600,600) → null');

  // 非 BuildingComp 实体（如 T1.6 测试 Sprite）不参与选中
  const plain = pickWorld.createEntity();
  pickWorld.addComponent(plain, 'Position', { x: 5 * CELL_SIZE, y: 5 * CELL_SIZE });
  pickWorld.addComponent(plain, 'SpriteComp', {
    group: 'devices' as const, textureKey: 'refining_unit',
    width: 3 * CELL_SIZE, height: 3 * CELL_SIZE, layer: 2,
  });
  assert(
    pickBuildingAt(pickWorld, 416, 416) === refiningA,
    '带 SpriteComp 但无 BuildingComp 的实体不参与命中（仍命中精炼炉）',
  );
  pickWorld.destroyEntity(plain);

  // selectable=false → 跳过（临时改定义，测完还原）
  const refiningDef = getBuildingDefinition('refining_unit')!;
  const originalSelectable = refiningDef.selectable;
  refiningDef.selectable = false;
  assert(pickBuildingAt(pickWorld, 416, 416) === null, 'selectable=false 的设备不参与命中');
  refiningDef.selectable = originalSelectable;
  assert(pickBuildingAt(pickWorld, 416, 416) === refiningA, 'selectable 还原后重新可命中');
}

type EntityHandleLike = ReturnType<World['createEntity']>;

// ───────────────────────── B. SelectionSystem 状态机 ─────────────────────────
console.log('\n[B] SelectionSystem 状态机 (T1.8 前瞻约束)');
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const layers = makeLayers();
  const camera = new Camera({ width: 800, height: 600 }, {
    widthPx: map.widthPx, heightPx: map.heightPx,
  });
  const sel = new SelectionSystem(world, camera, layers);
  const refining = getBuildingDefinition('refining_unit')!; // 3×3 @ (5,5)
  const shredding = getBuildingDefinition('shredding_unit')!; // 3×3 @ (0,0)
  const a = placeBuilding(world, occ, refining, 5, 5);
  const b = placeBuilding(world, occ, shredding, 0, 0);

  const screenOf = (wx: number, wy: number) => camera.worldToScreen(wx, wy);

  // 短按命中 → 选中
  const aCenter = screenOf(416, 416);
  sel.onPointerDown(aCenter.x, aCenter.y, 0, 1000);
  assert(sel.getSelected() === null, 'pointerdown 后未提交（不立即 commit）');
  sel.onPointerUp(1010);
  assert(sel.getSelected() === a, 'pointerup 短按(10ms<300ms) → 选中精炼炉');
  sel.update();

  // 右击不参与（pointerdown button=2 不记录 pending）
  sel.onPointerDown(aCenter.x, aCenter.y, 2, 2000);
  sel.onPointerUp(2010);
  assert(sel.getSelected() === a, '右键点击不影响选中态');

  // 点空白 → 取消
  const empty = screenOf(800, 800);
  sel.onPointerDown(empty.x, empty.y, 0, 3000);
  sel.onPointerUp(3010);
  assert(sel.getSelected() === null, '点空白短按 → 取消选中');
  const gB = (sel as unknown as { graphics: Graphics }).graphics;
  assert(gB.visible === false, '点空白取消后选中框 Graphics 立即隐藏（不印在画布上）');
  assert(sel.getBoxTopLeft() === null, '点空白取消后 lastBoxTopLeft 清空');
  sel.update();
  assert(gB.visible === false, '取消后 update() 不再绘制/恢复选中框（回归: 印在画布上）');

  // 长按(≥300ms) 不产生选中变更（Phase 2 由定时器接管为移动态）
  sel.onPointerDown(aCenter.x, aCenter.y, 0, 4000);
  sel.onPointerUp(4000 + SELECTION_SHORT_PRESS_MS);
  assert(sel.getSelected() === null, '长按(300ms) 不选中（为 Phase 2 移动态预留）');

  // 长按后再短按仍正常选中（pending 一次性消费，无残留）
  sel.onPointerDown(aCenter.x, aCenter.y, 0, 5000);
  sel.onPointerUp(5010);
  assert(sel.getSelected() === a, '长按之后短按仍可选中');

  // 切选另一设备
  const bCenter = screenOf(96, 96);
  sel.onPointerDown(bCenter.x, bCenter.y, 0, 6000);
  sel.onPointerUp(6010);
  assert(sel.getSelected() === b, '短按另一设备 → 选中切换为粉碎机');

  // 选中设备被销毁 → update 清空选中态
  world.destroyEntity(b);
  sel.update();
  assert(sel.getSelected() === null, '选中实体销毁后 update → 选中态清空');

  sel.destroy();
}

// ───────────────────────── C. buildingScreenPolygon 投影 ─────────────────────────
console.log('\n[C] buildingScreenPolygon 选中框投影 (跟随相机缩放/旋转)');
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const camera = new Camera({ width: 800, height: 600 }, {
    widthPx: map.widthPx, heightPx: map.heightPx,
  });
  const refining = getBuildingDefinition('refining_unit')!;
  const h = placeBuilding(world, occ, refining, 5, 5);

  // zoom=1, rot=0: 世界矩形 [320,512)² → 屏幕矩形 [304,204)² (192px)
  const pts0 = buildingScreenPolygon(camera, world, h)!;
  assert(pts0 !== null && pts0.length === 4, 'zoom=1 时返回 4 个顶点');
  const tl0 = camera.worldToScreen(320, 320);
  const br0 = camera.worldToScreen(512, 512);
  assert(
    pts0[0].x === tl0.x && pts0[0].y === tl0.y &&
    pts0[2].x === br0.x && pts0[2].y === br0.y,
    '四角与 worldToScreen 投影一致 (rot=0)',
  );
  assert(
    Math.abs((pts0[1].x - pts0[0].x) - 192) < 1e-6 &&
    Math.abs((pts0[2].y - pts0[1].y) - 192) < 1e-6,
    'zoom=1 时选中框屏幕尺寸 = 192×192',
  );

  // zoom=2 → 屏幕尺寸翻倍
  camera.setZoom(2);
  const pts2 = buildingScreenPolygon(camera, world, h)!;
  assert(
    Math.abs((pts2[1].x - pts2[0].x) - 384) < 1e-6 &&
    Math.abs((pts2[2].y - pts2[1].y) - 384) < 1e-6,
    'zoom=2 时选中框屏幕尺寸 = 384×384（跟随缩放）',
  );

  // 视图旋转 90°（走完过渡动画）→ 四角仍等于 worldToScreen 投影（旋转四边形）
  camera.setZoom(1);
  camera.rotateClockwise();
  camera.update(400); // CAMERA_ROTATE_ANIM_MS=220，400ms 必然走完
  const pts90 = buildingScreenPolygon(camera, world, h)!;
  const corners90 = [
    camera.worldToScreen(320, 320),
    camera.worldToScreen(512, 320),
    camera.worldToScreen(512, 512),
    camera.worldToScreen(320, 512),
  ];
  let allMatch = pts90.length === 4;
  for (let i = 0; i < 4 && allMatch; i++) {
    allMatch = Math.abs(pts90[i].x - corners90[i].x) < 1e-6 &&
      Math.abs(pts90[i].y - corners90[i].y) < 1e-6;
  }
  assert(allMatch, 'viewRotation=90° 时四角与旋转后投影一致（选中框跟随视图旋转）');
  const distinct = new Set(pts90.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)).size;
  assert(distinct === 4, '旋转后 4 顶点互不重合（非退化四边形）');
}

// ───────────────────────── D. 选中框 Graphics 生命周期 ─────────────────────────
console.log('\n[D] 选中框 Graphics 生命周期');
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const layers = makeLayers();
  const camera = new Camera({ width: 800, height: 600 }, {
    widthPx: map.widthPx, heightPx: map.heightPx,
  });
  const sel = new SelectionSystem(world, camera, layers);
  const g = (sel as unknown as { graphics: Graphics }).graphics;
  const refining = getBuildingDefinition('refining_unit')!;
  const h = placeBuilding(world, occ, refining, 5, 5);

  assert(g.visible === false, '初始选中框隐藏');
  assert(layers.overlayLayer.children.includes(g), '选中框挂在 overlayLayer（屏幕空间）');
  assert(g.zIndex < 0, '选中框 zIndex 为负（工具栏之下）');

  const c = camera.worldToScreen(416, 416);
  sel.onPointerDown(c.x, c.y, 0, 100);
  sel.onPointerUp(110);
  sel.update();
  assert(g.visible === true, '选中后 update → 选中框可见');
  assert(!g.isDestroyed, '绘制调用（clear+poly+stroke）正常执行，Graphics 未销毁');

  sel.clearSelection();
  assert(g.visible === false, 'clearSelection → 选中框隐藏');
  assert(sel.getSelected() === null, 'clearSelection → 选中态清空');

  // 点空白取消（不经 clearSelection）后 update 不抛错且框保持隐藏
  const empty2 = camera.worldToScreen(800, 800);
  sel.onPointerDown(empty2.x, empty2.y, 0, 200);
  sel.onPointerUp(210);
  sel.update();
  assert(g.visible === false, '点空白取消 + update → 框保持隐藏（不残留几何）');

  // 未选中时 update 不抛错
  sel.update();
  assert(true, '未选中时 update 安全 no-op');

  sel.destroy();
  assert(
    (g as unknown as { destroyed: boolean }).destroyed === true,
    'destroy → Graphics 销毁',
  );
}

// ───────────────────────── 常量 ─────────────────────────
console.log('\n[E] 前瞻约束常量');
assert(SELECTION_SHORT_PRESS_MS === 300, 'SELECTION_SHORT_PRESS_MS === 300 (T2.14 长按阈值)');

// ───────────────────────── 总结 ─────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`T1.8 验证: ${passed} 通过, ${failed} 失败`);
console.log('='.repeat(60));
if (failed > 0) {
  process.exit(1);
}
