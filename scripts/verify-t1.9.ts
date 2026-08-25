// T1.9 设备删除系统验证脚本
// 用法 (需 ts-loader 解析无后缀 import):
//   node --experimental-strip-types \
//        --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./scripts/ts-loader.mjs", pathToFileURL("./"));' \
//        scripts/verify-t1.9.ts
//
// 验证内容（纯逻辑 + headless PixiJS，无需浏览器）:
//   A. DeleteSystem 基础删除: 销毁实体 + 释放 footprint 全部 Cell + 可重新放置
//   B. 幂等/防御: null、已销毁 handle、非设备实体、未知 definitionId → false 无副作用
//   C. 多次删除一致性: 删中间设备不误伤邻居、删光后占位表零泄漏
//   D. RenderSystem 集成: 删除后 Sprite 自动移除（T1.6 query diff 路径）
//   E. T1.8 选中联动: 删除选中设备后选中态清空、选中框隐藏

import { Container, Sprite } from 'pixi.js';
import { createBufferSlots } from '../src/game/systems/machine/BufferOps';
import { World } from '../src/game/ECS.ts';
import { Camera } from '../src/game/render/Camera.ts';
import type { SceneLayers } from '../src/game/render/SceneRenderer.ts';
import { RenderSystem } from '../src/game/systems/RenderSystem.ts';
import { SelectionSystem } from '../src/game/systems/SelectionSystem.ts';
import { DeleteSystem } from '../src/game/systems/DeleteSystem.ts';
import { createOutputPollQueue, getBuildingDefinition, type BuildingDefinition } from '../src/game/data/buildings.ts';
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
    paused: false, // T2.8 字段（PortStatusOps 渲染需要；测试实体补全与 placeAt 同形）
    bufferInput: createBufferSlots(def.inputSlotCount), // T2.4
    bufferOutput: createBufferSlots(def.outputSlotCount), // T2.5
    inputPollIndex: 0, outputPollQueue: createOutputPollQueue(def), // T2.10
    currentRecipeId: null, progress: 0, elapsed: 0, // T2.5
  });
  world.addComponent(h, 'SpriteComp', {
    group: 'devices' as const, textureKey: def.texture,
    width: def.footprint.w * CELL_SIZE, height: def.footprint.h * CELL_SIZE, layer: 2,
  });
  occ.occupyFootprint(gx, gy, def, 0);
  return h;
}

// ───────────────────────── A. 基础删除 ─────────────────────────
console.log('\n[A] DeleteSystem 基础删除 (销毁 + 释放占用)');
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const del = new DeleteSystem(world, occ);
  const refining = getBuildingDefinition('refining_unit')!; // 3×3
  const h = placeBuilding(world, occ, refining, 5, 5);

  assert(world.isAlive(h), '删除前实体存活');
  assert(occ.occupiedCount === 9, `删除前占用 9 个 Cell (实际 ${occ.occupiedCount})`);
  assert(!occ.canPlace(5, 5, 3, 3), '删除前 (5,5) 3×3 不可放置');

  assert(del.deleteBuilding(h) === true, 'deleteBuilding(handle) → true');
  assert(!world.isAlive(h), '删除后实体已销毁');
  assert(occ.occupiedCount === 0, '删除后占用表清空 (0 Cell)');
  assert(occ.canPlace(5, 5, 3, 3), '删除后 (5,5) 3×3 可重新放置');
  assert(occ.snapshot().length === 0, '删除后占用快照为空');
}

// ───────────────────────── B. 幂等/防御 ─────────────────────────
console.log('\n[B] 幂等与防御 (无副作用)');
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const del = new DeleteSystem(world, occ);
  const refining = getBuildingDefinition('refining_unit')!;
  const h = placeBuilding(world, occ, refining, 0, 0);

  assert(del.deleteBuilding(null) === false, 'null handle → false');
  assert(world.entityCount() === 1 && occ.occupiedCount === 9, 'null 删除无副作用');

  assert(del.deleteBuilding(h) === true, '正常删除成功');
  assert(del.deleteBuilding(h) === false, '重复删除同一 handle → false (已销毁)');
  assert(world.entityCount() === 0 && occ.occupiedCount === 0, '重复删除无副作用');

  // 非设备实体（无 BuildingComp）不可删除
  const plain = world.createEntity();
  world.addComponent(plain, 'Position', { x: 2 * CELL_SIZE, y: 2 * CELL_SIZE });
  world.addComponent(plain, 'SpriteComp', {
    group: 'devices' as const, textureKey: 'refining_unit',
    width: 3 * CELL_SIZE, height: 3 * CELL_SIZE, layer: 2,
  });
  assert(del.deleteBuilding(plain) === false, '无 BuildingComp 的实体 → false');
  assert(world.isAlive(plain), '无 BuildingComp 实体未被销毁');
  world.destroyEntity(plain);

  // 未知 definitionId → 拒绝删除（不信任释放占用）
  const ghost = world.createEntity();
  world.addComponent(ghost, 'Position', { x: 3 * CELL_SIZE, y: 3 * CELL_SIZE });
  world.addComponent(ghost, 'BuildingComp', {
    definitionId: 'unknown_def', direction: 0 as Direction, state: 'idle' as const,
  });
  world.addComponent(ghost, 'SpriteComp', {
    group: 'devices' as const, textureKey: 'refining_unit',
    width: 3 * CELL_SIZE, height: 3 * CELL_SIZE, layer: 2,
  });
  assert(del.deleteBuilding(ghost) === false, '未知 definitionId → false');
  assert(world.isAlive(ghost), '未知定义实体未被销毁');
  world.destroyEntity(ghost);
}

// ───────────────────────── C. 多次删除一致性 ─────────────────────────
console.log('\n[C] 多次删除一致性 (无占位泄漏/误伤)');
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const del = new DeleteSystem(world, occ);
  const refining = getBuildingDefinition('refining_unit')!; // 3×3
  const shredding = getBuildingDefinition('shredding_unit')!; // 3×3
  const seed = getBuildingDefinition('seed_picking_unit')!; // 5×5

  const a = placeBuilding(world, occ, refining, 0, 0);    // 3×3 @ (0,0)
  const b = placeBuilding(world, occ, shredding, 4, 0);   // 3×3 @ (4,0)
  const c = placeBuilding(world, occ, seed, 0, 4);        // 5×5 @ (0,4)
  assert(occ.occupiedCount === 9 + 9 + 25, `三设备占用 ${9 + 9 + 25} Cell (实际 ${occ.occupiedCount})`);

  // 删中间设备：不误伤邻居
  assert(del.deleteBuilding(b) === true, '删除中间设备成功');
  assert(world.isAlive(a) && world.isAlive(c), '邻居实体未被销毁');
  assert(occ.occupiedCount === 9 + 25, `删除后占用 ${9 + 25} Cell (实际 ${occ.occupiedCount})`);
  assert(occ.canPlace(4, 0, 3, 3), '被删设备的格子可重新放置');
  assert(!occ.canPlace(0, 0, 3, 3), '邻居 (0,0) 3×3 仍被占用');

  // 删光：占位表零泄漏
  assert(del.deleteBuilding(a) === true, '删除 a 成功');
  assert(del.deleteBuilding(c) === true, '删除 c 成功');
  assert(world.entityCount() === 0, `全部删除后实体数 0 (实际 ${world.entityCount()})`);
  assert(occ.occupiedCount === 0, `全部删除后占用 0 Cell (实际 ${occ.occupiedCount})`);
  assert(occ.snapshot().length === 0, '占用快照为空');
}

// ───────────────────────── D. RenderSystem 集成 ─────────────────────────
console.log('\n[D] RenderSystem 集成 (删除 → Sprite 自动移除)');
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const layers = makeLayers();
  const camera = new Camera({ width: 800, height: 600 }, {
    widthPx: map.widthPx, heightPx: map.heightPx,
  });
  const render = new RenderSystem(world, layers, camera, () => undefined);
  const del = new DeleteSystem(world, occ);
  const refining = getBuildingDefinition('refining_unit')!;
  const h = placeBuilding(world, occ, refining, 2, 2);

  render.update();
  // T2.0 起 RenderSystem 构造时把 BeltHoverRenderer 的 beltHover Graphics 常驻挂到
  // layer2Building（悬停高亮层），层的 children 不再只含建筑渲染根。
  // T1.11c 起渲染根有两种: whole 设备 = Sprite，nineslice 设备 = Container
  // （label 前缀 nineslice-device）。断言按两种形态找唯一渲染根。
  const findRoot = () => layers.layer2Building.children.find(
    (c) => c instanceof Sprite ||
      (typeof (c as Container).label === 'string' && (c as Container).label.startsWith('nineslice-device')),
  );
  const root = findRoot();
  assert(root !== undefined, '放置后渲染根挂到 building 层');

  assert(del.deleteBuilding(h) === true, '删除设备成功');
  render.update();
  assert(findRoot() === undefined, '删除后下一帧渲染根自动移除');
  assert(
    (root as unknown as { destroyed: boolean }).destroyed === true,
    '旧渲染根已被销毁（无泄漏）',
  );
}

// ───────────────────────── E. T1.8 选中联动 ─────────────────────────
console.log('\n[E] T1.8 选中联动 (删除后选中态清空)');
{
  const map = new MapInstance({ widthCells: 16, heightCells: 16 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const layers = makeLayers();
  const camera = new Camera({ width: 800, height: 600 }, {
    widthPx: map.widthPx, heightPx: map.heightPx,
  });
  const sel = new SelectionSystem(world, camera, layers);
  const del = new DeleteSystem(world, occ);
  const refining = getBuildingDefinition('refining_unit')!;
  const h = placeBuilding(world, occ, refining, 5, 5);

  // 选中设备（pointerdown/pointerup 短按，T1.8 真实路径）
  const c = camera.worldToScreen(416, 416);
  sel.onPointerDown(c.x, c.y, 0, 100);
  sel.onPointerUp(110);
  sel.update();
  assert(sel.getSelected() === h, 'T1.8 选中成功');
  const g = (sel as unknown as { graphics: { visible: boolean } }).graphics;
  assert(g.visible === true, '选中框可见');

  // 删除选中设备 + 调用方 clearSelection（main.ts 的 Delete 键路径）
  assert(del.deleteBuilding(sel.getSelected()) === true, '删除选中设备成功');
  sel.clearSelection();
  assert(sel.getSelected() === null, '删除后选中态清空');
  assert(g.visible === false, '删除后选中框隐藏');

  // 若调用方忘记 clearSelection，update() 也应兜底清空（T1.8 已实现）
  const h2 = placeBuilding(world, occ, refining, 8, 8);
  const c2 = camera.worldToScreen(8 * CELL_SIZE + 96, 8 * CELL_SIZE + 96);
  sel.onPointerDown(c2.x, c2.y, 0, 200);
  sel.onPointerUp(210);
  sel.update();
  assert(sel.getSelected() === h2, '第二次选中成功');
  del.deleteBuilding(h2);
  sel.update(); // 不手动 clearSelection，靠 update() 兜底
  assert(sel.getSelected() === null, '实体销毁后 update() 兜底清空选中态');
  assert(g.visible === false, '兜底路径选中框隐藏');
}

// ───────────────────────── 总结 ─────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`T1.9 验证: ${passed} 通过, ${failed} 失败`);
console.log('='.repeat(60));
if (failed > 0) {
  process.exit(1);
}
