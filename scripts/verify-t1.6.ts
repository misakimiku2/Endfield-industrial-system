// T1.6 渲染系统验证脚本
// 用法 (需 ts-loader 解析无后缀 import):
//   node --experimental-strip-types \
//        --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./scripts/ts-loader.mjs", pathToFileURL("./"));' \
//        scripts/verify-t1.6.ts
//
// 验证内容:
//   A. MapInstance（A11 WV-003 §4.4）: 默认 64×64 → widthPx/heightPx = 4096；尺寸校验
//   B. Camera 用 MapInstance bounds: 边界 clamp 行为与改造前数值一致（4096 世界）
//   C. RenderSystem diff: query 新增实体 → 建 Sprite；销毁 → Sprite 被清理
//   D. RenderSystem layer 映射: SpriteComp.layer 落到对应 SceneLayers Container
//   E. RenderSystem 视口剔除: 屏幕外 Sprite visible=false，屏幕内 visible=true
//   F. RenderSystem 纹理/层级变更触发重建（group/textureKey/layer 任一变化）
//
// 说明: RenderSystem 依赖 PixiJS Sprite（Node 下 Texture.EMPTY 可用，无需 canvas），
//       World/Camera/SceneLayers 用真实或轻量实现，getTexture 注入 mock。

import { Container, Sprite, Texture } from 'pixi.js';
import { createDefaultMap, MapInstance } from '../src/game/world/MapInstance.ts';
import { Camera } from '../src/game/render/Camera.ts';
import { World } from '../src/game/ECS.ts';
import { RenderSystem } from '../src/game/systems/RenderSystem.ts';
import type { SceneLayers } from '../src/game/render/SceneRenderer.ts';
import type { TextureLookup } from '../src/game/systems/RenderSystem.ts';
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

// ── 辅助: 搭建一个最小 SceneLayers（用真实 PixiJS Container，便于测 addChild/removeChild）──
function makeSceneLayers(): SceneLayers {
  const mk = (label: string) => new Container({ label });
  const backgroundLayer = mk('bg');
  const worldContainer = mk('world');
  const layer0Terrain = mk('layer0');
  const layer1Grid = mk('layer1');
  const layer2Building = mk('layer2');
  const layer3Item = mk('layer3');
  const layer4Enemy = mk('layer4');
  const layer5Effect = mk('layer5');
  const overlayLayer = mk('overlay');
  return {
    backgroundLayer, worldContainer,
    layer0Terrain, layer1Grid, layer2Building, layer3Item, layer4Enemy, layer5Effect,
    overlayLayer,
  };
}

// ── 辅助: mock getTexture（返回 Texture.EMPTY 即可，RenderSystem 仅做 new Sprite(tex)）──
const texLookup: TextureLookup = (_group, _key) => Texture.EMPTY;

// T2.0 起 RenderSystem 构造时把 BeltHoverRenderer 的 beltHover Graphics 常驻挂到
// layer2Building（悬停高亮层），层的 children 不再只含实体 Sprite。
// 计数/取用断言一律只数 Sprite 实例，忽略渲染器自有对象。
const spritesOf = (layer: Container): Sprite[] =>
  layer.children.filter((c): c is Sprite => c instanceof Sprite);

console.log('\n=== T1.6 渲染系统验证 (MapInstance + Camera bounds + RenderSystem) ===\n');

// ── A. MapInstance（A11 WV-003 §4.4）──
console.log('[A] MapInstance 默认尺寸与校验');
{
  const map = createDefaultMap();
  assert(map.widthCells === 64 && map.heightCells === 64, `默认地图 64×64 cells`);
  assert(map.widthPx === 4096 && map.heightPx === 4096, `默认地图 4096×4096 世界像素 (CELL_SIZE=${CELL_SIZE})`);

  const custom = new MapInstance({ widthCells: 32, heightCells: 100 });
  assert(custom.widthPx === 32 * CELL_SIZE && custom.heightPx === 100 * CELL_SIZE,
    `自定义地图尺寸 32×100 → ${32 * CELL_SIZE}×${100 * CELL_SIZE}`);

  let threw = false;
  try { new MapInstance({ widthCells: 0, heightCells: 10 }); } catch { threw = true; }
  assert(threw, `widthCells=0 抛错（尺寸必须为正）`);
}

// ── B. Camera 用 MapInstance bounds（边界 clamp 回归）──
console.log('\n[B] Camera 边界 clamp 读 MapInstance（4096 世界，与改造前一致）');
{
  const map = createDefaultMap();
  const bounds = { widthPx: map.widthPx, heightPx: map.heightPx };
  const VIEWPORT = { width: 1280, height: 720 };
  const cam = new Camera(VIEWPORT, bounds);

  // 初始中心 = 世界中央
  assert(Math.abs(cam.x - 2048) < 0.001 && Math.abs(cam.y - 2048) < 0.001,
    `初始中心在世界中央 (2048,2048)`);

  // 右下越界 clamp
  cam.setPosition(99999, 99999);
  const halfW = VIEWPORT.width / 2;
  const halfH = VIEWPORT.height / 2;
  assert(Math.abs(cam.x - (4096 - halfW)) < 0.001 && Math.abs(cam.y - (4096 - halfH)) < 0.001,
    `右下越界 clamp 到 (${4096 - halfW},${4096 - halfH})（与改造前数值一致）`);

  // 切换到更小的世界 → setWorldBounds 后 clamp 到新边界
  cam.setWorldBounds({ widthPx: 2048, heightPx: 2048 });
  assert(Math.abs(cam.x - (2048 - halfW)) < 0.001 && Math.abs(cam.y - (2048 - halfH)) < 0.001,
    `setWorldBounds(2048×2048) 后 clamp 到新边界`);
}

// ── C. RenderSystem diff（新增/销毁）──
console.log('\n[C] RenderSystem diff: 创建→建 Sprite，销毁→Sprite 清理');
{
  const world = new World();
  const layers = makeSceneLayers();
  const cam = new Camera({ width: 1280, height: 720 }, { widthPx: 4096, heightPx: 4096 });
  const rs = new RenderSystem(world, layers, cam, texLookup);

  // 视口中心放一个实体（保证在视口内）
  const e1 = world.createEntity();
  world.addComponent(e1, 'Position', { x: 1900, y: 1900 });
  world.addComponent(e1, 'SpriteComp', { group: 'devices', textureKey: 'refining_unit', width: 192, height: 192, layer: 2 });

  assert(spritesOf(layers.layer2Building).length === 0, `update 前 building 层无 Sprite`);
  rs.update();
  assert(spritesOf(layers.layer2Building).length === 1, `update 后 building 层新增 1 个 Sprite`);

  // 销毁实体 → 下一帧 Sprite 被移除
  world.destroyEntity(e1);
  rs.update();
  assert(spritesOf(layers.layer2Building).length === 0, `销毁实体后 Sprite 被清理（层内无 Sprite）`);

  // 多实体增删混合
  const handles: number[] = [];
  for (let i = 0; i < 5; i++) {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: 1900 + i * 10, y: 1900 });
    world.addComponent(h, 'SpriteComp', { group: 'devices', textureKey: 'transport_belt', width: 64, height: 64, layer: 2 });
    handles.push(h);
  }
  rs.update();
  assert(spritesOf(layers.layer2Building).length === 5, `5 个实体 → 5 个 Sprite`);
  world.destroyEntity(handles[0]);
  world.destroyEntity(handles[2]);
  rs.update();
  assert(spritesOf(layers.layer2Building).length === 3, `销毁 2 个 → 剩 3 个 Sprite`);
  rs.clear();
  assert(spritesOf(layers.layer2Building).length === 0, `clear() 后 Sprite 全部清理`);
}

// ── D. layer 映射 ──
console.log('\n[D] SpriteComp.layer 落到对应 SceneLayers Container');
{
  const world = new World();
  const layers = makeSceneLayers();
  const cam = new Camera({ width: 1280, height: 720 }, { widthPx: 4096, heightPx: 4096 });
  const rs = new RenderSystem(world, layers, cam, texLookup);
  const layerNames: Array<keyof SceneLayers> = [
    'layer0Terrain', 'layer1Grid', 'layer2Building', 'layer3Item', 'layer4Enemy', 'layer5Effect',
  ];
  for (let li = 0; li < 6; li++) {
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: 1900, y: 1900 });
    world.addComponent(h, 'SpriteComp', { group: 'devices', textureKey: 'x', width: 64, height: 64, layer: li });
  }
  rs.update();
  let ok = true;
  for (let li = 0; li < 6; li++) {
    if (spritesOf(layers[layerNames[li]]).length !== 1) ok = false;
    // 其它层不应被误塞
  }
  assert(ok, `6 个实体 layer=0..5 各落到对应层 Container（每层恰好 1 个）`);
}

// ── E. 视口剔除 ──
console.log('\n[E] 视口剔除: 屏幕外 visible=false，屏幕内 visible=true');
{
  const world = new World();
  const layers = makeSceneLayers();
  // 视口 1280×720，相机中心 2048 → 屏幕中心世界坐标 = (2048,2048)，可见世界范围约 [1408,2688]
  const cam = new Camera({ width: 1280, height: 720 }, { widthPx: 4096, heightPx: 4096 });
  const rs = new RenderSystem(world, layers, cam, texLookup);

  const inside = world.createEntity(); // 视口内
  world.addComponent(inside, 'Position', { x: 2000, y: 2000 });
  world.addComponent(inside, 'SpriteComp', { group: 'devices', textureKey: 'a', width: 64, height: 64, layer: 2 });

  const farOutside = world.createEntity(); // 远在视口外（世界左上角附近）
  world.addComponent(farOutside, 'Position', { x: 0, y: 0 });
  world.addComponent(farOutside, 'SpriteComp', { group: 'devices', textureKey: 'b', width: 64, height: 64, layer: 2 });

  rs.update();
  const insideSprite = spritesOf(layers.layer2Building)[0];
  const outsideSprite = spritesOf(layers.layer2Building)[1];
  assert((insideSprite as { visible: boolean }).visible === true, `视口内实体 visible=true`);
  assert((outsideSprite as { visible: boolean }).visible === false, `视口外实体 visible=false（剔除）`);

  // 平移相机让"远处"实体进入视口 → 应变为可见
  cam.setPosition(64, 64); // 相机看世界左上角
  rs.update();
  assert((outsideSprite as { visible: boolean }).visible === true, `相机平移后远处实体进入视口 → visible=true`);
}

// ── F. 纹理/层级变更触发重建 ──
console.log('\n[F] SpriteComp 的 group/textureKey/layer 变更 → 重建 Sprite');
{
  const world = new World();
  const layers = makeSceneLayers();
  const cam = new Camera({ width: 1280, height: 720 }, { widthPx: 4096, heightPx: 4096 });
  const rs = new RenderSystem(world, layers, cam, texLookup);

  const h = world.createEntity();
  world.addComponent(h, 'Position', { x: 2000, y: 2000 });
  world.addComponent(h, 'SpriteComp', { group: 'devices', textureKey: 'a', width: 64, height: 64, layer: 2 });
  rs.update();
  assert(spritesOf(layers.layer2Building).length === 1 && spritesOf(layers.layer3Item).length === 0,
    `初始 layer=2 → building 层 1 个，item 层 0 个`);

  // 改 layer → Sprite 应从 building 层移到 item 层（重建）
  world.addComponent(h, 'SpriteComp', { group: 'devices', textureKey: 'a', width: 64, height: 64, layer: 3 });
  rs.update();
  assert(spritesOf(layers.layer2Building).length === 0 && spritesOf(layers.layer3Item).length === 1,
    `改为 layer=3 → Sprite 迁到 item 层（building 清空，item 1 个）`);

  // 改 textureKey → 仍 1 个 Sprite（重建，旧的被销毁）
  world.addComponent(h, 'SpriteComp', { group: 'devices', textureKey: 'changed', width: 64, height: 64, layer: 3 });
  rs.update();
  assert(spritesOf(layers.layer3Item).length === 1, `改 textureKey → 重建后 item 层仍 1 个 Sprite（旧销毁新建）`);
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
if (failed > 0) process.exit(1);
