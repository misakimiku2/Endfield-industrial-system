// T1.10 性能基准验证脚本（纯逻辑 + headless PixiJS，无需浏览器）
// 用法 (需 ts-loader 解析无后缀 import):
//   node --experimental-strip-types \
//        --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./scripts/ts-loader.mjs", pathToFileURL("./"));' \
//        scripts/verify-t1.10.ts
//
// 验证内容:
//   A. 一键 100 设备（真实放置路径）: 随机落点 + 占用检查 → 100 实体/900 Cell/无重叠
//   B. 纹理共享（内存关注点）: 100 设备只引用 2 个共享图集纹理，不产生逐设备纹理
//   C. 视口剔除: 放大到局部 → 远处设备隐藏、近处可见；缩小 → 全部可见
//   D. 清空/内存释放: 生成 100 → 清空 ×3 轮，Sprite 全销毁、占用零泄漏
//   E. PerfMonitor 报告: FPS 采样汇总 / 内存快照字段 / met55 判定

import {
  Container,
  Sprite,
  Texture,
  TextureSource,
  type Application,
} from 'pixi.js';
import { World } from '../src/game/ECS.ts';
import { createBufferSlots } from '../src/game/systems/machine/BufferOps';
import { Camera } from '../src/game/render/Camera.ts';
import type { SceneLayers } from '../src/game/render/SceneRenderer.ts';
import { RenderSystem } from '../src/game/systems/RenderSystem.ts';
import { PerfMonitor } from '../src/game/perf/PerfMonitor.ts';
import { getBuildingDefinition, type BuildingDefinition } from '../src/game/data/buildings.ts';
import type { Direction } from '../src/game/components/BuildingComp.ts';
import { MapInstance } from '../src/game/world/MapInstance.ts';
import { OccupancyMap } from '../src/game/world/OccupancyMap.ts';
import { CELL_SIZE } from '../src/game/render/constants.ts';
/** T1.11c: 设备渲染根有两种形态（whole=Sprite / nineslice=Container label 前缀）。 */
const deviceRenderRoots = (layer: { children: unknown[] }): unknown[] =>
  layer.children.filter((c) =>
    c instanceof Sprite ||
    (c instanceof Container &&
      String((c as Container).label ?? '').startsWith('nineslice-device')));


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

/** 共享图集纹理（模拟 T1.3 图集：同一 key 只存在一个 Texture 实例）。 */
function makeSharedTextures(): Map<string, Texture> {
  const map = new Map<string, Texture>();
  map.set(
    'devices/refining_unit',
    new Texture({
      source: new TextureSource({ width: 192, height: 192, label: 'refining_unit' }),
      label: 'devices/refining_unit',
    }),
  );
  map.set(
    'devices/refining_unit/logo',
    new Texture({
      source: new TextureSource({ width: 64, height: 64, label: 'refining_unit/logo' }),
      label: 'devices/refining_unit/logo',
    }),
  );
  map.set(
    'devices/refining_unit/logo-glow',
    new Texture({
      source: new TextureSource({ width: 64, height: 64, label: 'refining_unit/logo-glow' }),
      label: 'devices/refining_unit/logo-glow',
    }),
  );
  // T1.11c: refining_unit 底座走九宫格切片（无 renderer 的测试环境为逐切片容器）
  for (const k of ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br']) {
    if (k === 'c') continue; // 中心块空心，图集不打包
    map.set(
      `devices/nineslice/${k}`,
      new Texture({
        source: new TextureSource({ width: 288, height: 288, label: `nineslice/${k}` }),
        label: `devices/nineslice/${k}`,
      }),
    );
  }
  return map;
}

/**
 * 复刻 main.ts 的 spawnBenchmarkDevices 逻辑（真实放置路径）:
 * refining_unit 3×3 随机落点 + OccupancyMap 占用检查，全部不重叠。
 */
function spawnBenchmarkDevices(
  world: World,
  occ: OccupancyMap,
  map: MapInstance,
  n: number,
): number {
  const def = getBuildingDefinition('refining_unit')!;
  const { w, h } = def.footprint;
  const maxGx = Math.max(0, map.widthCells - w);
  const maxGy = Math.max(0, map.heightCells - h);
  let placed = 0;
  let attempts = 0;
  const maxAttempts = n * 200 + 2000;
  while (placed < n && attempts < maxAttempts) {
    attempts++;
    const gx = Math.floor(Math.random() * (maxGx + 1));
    const gy = Math.floor(Math.random() * (maxGy + 1));
    if (!occ.canPlace(gx, gy, w, h)) continue;
    const hEntity = world.createEntity();
    world.addComponent(hEntity, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    world.addComponent(hEntity, 'BuildingComp', {
      definitionId: def.id, direction: 0 as Direction, state: 'idle' as const,
    paused: false, // T2.8 字段（PortStatusOps 渲染需要；测试实体补全与 placeAt 同形）
    bufferInput: createBufferSlots(def.inputSlotCount), // T2.4
    bufferOutput: createBufferSlots(def.outputSlotCount), // T2.5
    currentRecipeId: null, progress: 0, elapsed: 0, // T2.5
    });
    world.addComponent(hEntity, 'SpriteComp', {
      group: 'devices' as const, textureKey: def.texture,
      width: w * CELL_SIZE, height: h * CELL_SIZE, layer: 2,
      logoTextureKey: def.logoTextureKey, // 与 main.ts placeAt / PlacementSystem 落盘一致
    });
    occ.occupyFootprint(gx, gy, def, 0);
    placed++;
  }
  return placed;
}

function findSpriteAt(
  container: Container,
  wx: number,
  wy: number,
): Sprite | undefined {
  return container.children.find((c) => {
    const s = c as Sprite;
    return Math.abs(s.x - wx) < 1 && Math.abs(s.y - wy) < 1;
  }) as Sprite | undefined;
}

function isDestroyed(obj: unknown): boolean {
  return (obj as { destroyed: boolean }).destroyed === true;
}

// ───────────────────────── A. 一键 100 设备 ─────────────────────────
console.log('\n[A] 一键 100 设备（真实放置路径: 随机落点 + 占用检查）');
{
  const map = new MapInstance({ widthCells: 64, heightCells: 64 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const layers = makeLayers();
  const camera = new Camera({ width: 1280, height: 720 }, {
    widthPx: map.widthPx, heightPx: map.heightPx,
  });
  const textures = makeSharedTextures();
  const getTex = (group: string, key: string) => textures.get(`${group}/${key}`);
  const render = new RenderSystem(world, layers, camera, getTex);

  const placed = spawnBenchmarkDevices(world, occ, map, 100);
  assert(placed === 100, `一键生成 100 个设备（实际 ${placed}）`);
  assert(world.entityCount() === 100, `ECS 实体数 = 100（实际 ${world.entityCount()}）`);
  assert(occ.occupiedCount === 900, `占用表 = 100×9 = 900 Cell（实际 ${occ.occupiedCount}）`);
  assert(occ.snapshot().length === 900, '占用快照无重复 Cell（随机放置零重叠）');

  render.update();
  assert(render.spriteCount === 100, `RenderSystem Sprite = 100（实际 ${render.spriteCount}）`);
  assert(deviceRenderRoots(layers.layer2Building).length === 100, 'building 层挂载 100 个渲染根');

  // 缩小到整图可见: 动态最小缩放 = min(0.25, 720/4096) ≈ 0.176
  // （T1.10 要求: 64×64 地图在 1280×720 视口下能整图可见）
  camera.setZoom(0.1);
  camera.setPosition(map.widthPx / 2, map.heightPx / 2);
  render.update();
  assert(
    render.visibleSpriteCount === 100,
    `缩小后 100 个设备全部可见（实际 ${render.visibleSpriteCount}）`,
  );
  assert(
    Math.abs(camera.zoom - 720 / map.heightPx) < 0.001,
    `动态最小缩放 ≈ 视口/世界适配缩放（实际 ${camera.zoom.toFixed(4)}）`,
  );
}

// ───────────────────────── B. 纹理共享（内存关注点） ─────────────────────────
console.log('\n[B] 纹理共享（100 设备只引用图集共享纹理，不产生逐设备纹理）');
{
  const map = new MapInstance({ widthCells: 64, heightCells: 64 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const layers = makeLayers();
  const camera = new Camera({ width: 1280, height: 720 }, {
    widthPx: map.widthPx, heightPx: map.heightPx,
  });
  const textures = makeSharedTextures();
  const getTex = (group: string, key: string) => textures.get(`${group}/${key}`);
  const render = new RenderSystem(world, layers, camera, getTex);

  spawnBenchmarkDevices(world, occ, map, 100);
  render.update();

  // T2.0 起 layer2Building 常驻 BeltHoverRenderer 的 beltHover Graphics（构造即挂载），
  // 只统计/取用 Sprite 实例，忽略渲染器自有对象。
  const sprites = deviceRenderRoots(layers.layer2Building) as Array<{
    visible: boolean; destroyed?: boolean; children?: Array<unknown>;
  }>;
  // 递归收集渲染根子树的全部纹理实例（whole: Sprite.texture + logo；
  // nineslice: [底座切片容器(8 Sprite), equipment Sprite, logo] —— 10 个共享纹理）
  const collectTextures = (node: { texture?: Texture; children?: unknown[] }): Texture[] => {
    const out: Texture[] = [];
    if (node.texture) out.push(node.texture);
    for (const child of node.children ?? []) {
      out.push(...collectTextures(child as { texture?: Texture; children?: unknown[] }));
    }
    return out;
  };
  const used = new Set<Texture>();
  // ⚠️ Set.add 非变参——必须逐个 add（used.add(...list) 只会加第一个）
  for (const sprite of sprites) for (const t of collectTextures(sprite as never)) used.add(t);
  // T1.11c: refining 迁移九宫格后 = 8 切片 + equipment + logo + logo-glow +
  // 1 个全设备共享的程序化兜底 Graphics 纹理（pause/blocked fallback）= 12
  assert(used.size === 12, `100 设备只引用 12 个共享纹理（8切片+equip+logo+glow+兜底，实际 ${used.size} 个）`);
  assert(
    [...used].filter((t) => t.label).every((t) => [...textures.values()].includes(t)),
    '所有图集引用纹理均来自共享集合（无逐设备新建纹理；无 label 的 Graphics 兜底纹理除外）',
  );
  assert(
    sprites.every((s) => (s.children ?? []).length === 3),
    '每个设备渲染根 = [底座, equipment, logo] 三子树（nineslice 结构）',
  );
  // 图集共享是"增删设备不涨纹理内存"的前提: 同 key 的 Sprite 必须是同一 Texture 实例
  const firstTex = collectTextures(sprites[0] as never);
  const lastTex = collectTextures(sprites[99] as never);
  assert(
    firstTex.length === lastTex.length && firstTex.every((t, i) => t === lastTex[i]),
    '第 1 个与第 100 个设备全部纹理实例一一共享（底座/主体/logo）',
  );
}

// ───────────────────────── C. 视口剔除 ─────────────────────────
console.log('\n[C] 视口剔除（放大看局部 FPS 压力小，缩小全可见）');
{
  const map = new MapInstance({ widthCells: 64, heightCells: 64 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const layers = makeLayers();
  const camera = new Camera({ width: 1280, height: 720 }, {
    widthPx: map.widthPx, heightPx: map.heightPx,
  });
  const textures = makeSharedTextures();
  const getTex = (group: string, key: string) => textures.get(`${group}/${key}`);
  const render = new RenderSystem(world, layers, camera, getTex);

  // 两个相距很远的设备: (1,1) 与 (58,58)
  const def = getBuildingDefinition('refining_unit')!;
  const place = (gx: number, gy: number) => {
    occ.occupyFootprint(gx, gy, def, 0);
    const h = world.createEntity();
    world.addComponent(h, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    world.addComponent(h, 'BuildingComp', {
      definitionId: def.id, direction: 0 as Direction, state: 'idle' as const,
    paused: false, // T2.8 字段（PortStatusOps 渲染需要；测试实体补全与 placeAt 同形）
    bufferInput: createBufferSlots(def.inputSlotCount), // T2.4
    bufferOutput: createBufferSlots(def.outputSlotCount), // T2.5
    currentRecipeId: null, progress: 0, elapsed: 0, // T2.5
    });
    world.addComponent(h, 'SpriteComp', {
      group: 'devices' as const, textureKey: def.texture,
      width: def.footprint.w * CELL_SIZE, height: def.footprint.h * CELL_SIZE, layer: 2,
    });
    return h;
  };
  const a = place(1, 1);
  const b = place(58, 58);
  render.update();

  // 放大到设备 A（zoom=4 → 1280×720 视口只看到 320×180 世界像素）
  camera.setZoom(4);
  camera.setPosition(1 * CELL_SIZE + 96, 1 * CELL_SIZE + 96);
  render.update();
  assert(render.spriteCount === 2, '剔除只切 visible，不销毁 Sprite');
  assert(render.visibleSpriteCount === 1, `放大后仅 A 可见（实际 ${render.visibleSpriteCount}）`);
  const spriteA = findSpriteAt(layers.layer2Building, 1 * CELL_SIZE + 96, 1 * CELL_SIZE + 96)!;
  const spriteB = findSpriteAt(layers.layer2Building, 58 * CELL_SIZE + 96, 58 * CELL_SIZE + 96)!;
  assert(spriteA.visible === true, '近处设备 A 可见');
  assert(spriteB.visible === false, '远处设备 B 被剔除（隐藏）');
  assert(world.isAlive(a) && world.isAlive(b), '剔除不销毁 ECS 实体');

  // 缩小到整图 → 两个都可见
  camera.setZoom(0.1);
  camera.setPosition(map.widthPx / 2, map.heightPx / 2);
  render.update();
  assert(
    render.visibleSpriteCount === 2 && spriteA.visible && spriteB.visible,
    '缩小后全部可见',
  );
}

// ───────────────────────── D. 清空/内存释放 ─────────────────────────
console.log('\n[D] 清空/内存释放（生成 100 → 清空 ×3 轮，无 Sprite/占位泄漏）');
{
  const map = new MapInstance({ widthCells: 64, heightCells: 64 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const layers = makeLayers();
  const camera = new Camera({ width: 1280, height: 720 }, {
    widthPx: map.widthPx, heightPx: map.heightPx,
  });
  const textures = makeSharedTextures();
  const getTex = (group: string, key: string) => textures.get(`${group}/${key}`);
  const render = new RenderSystem(world, layers, camera, getTex);

  const clearAll = () => {
    const handles = world.query('BuildingComp');
    for (const h of handles) world.destroyEntity(h);
    occ.clear();
    render.update();
  };

  for (let cycle = 1; cycle <= 3; cycle++) {
    const placed = spawnBenchmarkDevices(world, occ, map, 100);
    render.update();
    assert(placed === 100 && render.spriteCount === 100, `第${cycle}轮: 生成 100 个`);
    // beltHover Graphics 常驻 building 层（T2.0 起），只收集 Sprite 实例做泄漏断言
    const sprites = deviceRenderRoots(layers.layer2Building) as Array<{ visible: boolean; destroyed?: boolean }>;
    clearAll();
    assert(world.entityCount() === 0, `第${cycle}轮: 实体清空`);
    assert(occ.occupiedCount === 0 && occ.snapshot().length === 0, `第${cycle}轮: 占用零泄漏`);
    assert(render.spriteCount === 0, `第${cycle}轮: RenderSystem entries 清空`);
    assert(deviceRenderRoots(layers.layer2Building).length === 0, `第${cycle}轮: building 层无残留渲染根`);
    assert(
      sprites.every((s) => isDestroyed(s)),
      `第${cycle}轮: 旧 Sprite 全部 destroy（无泄漏）`,
    );
  }
}

// ───────────────────────── E. PerfMonitor 报告 ─────────────────────────
console.log('\n[E] PerfMonitor（FPS 汇总 + 内存快照 + met55 判定）');
{
  const map = new MapInstance({ widthCells: 64, heightCells: 64 });
  const occ = new OccupancyMap(map);
  const world = new World();
  const layers = makeLayers();
  const camera = new Camera({ width: 1280, height: 720 }, {
    widthPx: map.widthPx, heightPx: map.heightPx,
  });
  const textures = makeSharedTextures();
  const getTex = (group: string, key: string) => textures.get(`${group}/${key}`);
  const render = new RenderSystem(world, layers, camera, getTex);
  spawnBenchmarkDevices(world, occ, map, 100);
  render.update();

  // 无浏览器渲染器的 headless 环境: renderer.texture 不存在 → 纹理统计安全降级为 0。
  // 假 ticker 用 add/remove + 1ms 定时驱动，模拟真实 rAF 每帧一次。
  const listeners = new Set<() => void>();
  const fakeApp = {
    renderer: {},
    ticker: {
      get FPS() { return 60; },
      add(cb: () => void) { listeners.add(cb); },
      remove(cb: () => void) { listeners.delete(cb); },
    },
  } as unknown as Application;
  const perf = new PerfMonitor(fakeApp, world, render, occ);

  // 先缩到整图可见，让 visibleSpriteCount 统计的是"100 全可见"状态
  camera.setZoom(0.1);
  camera.setPosition(map.widthPx / 2, map.heightPx / 2);
  render.update();

  const mem = perf.sampleMemory();
  assert(mem.sprites === 100, `内存快照 sprites=100（实际 ${mem.sprites}）`);
  assert(mem.visibleSprites === 100, `内存快照 visibleSprites=100（实际 ${mem.visibleSprites}）`);
  assert(mem.occupiedCells === 900, `内存快照 occupiedCells=900（实际 ${mem.occupiedCells}）`);
  assert(mem.textureSources === 0, 'headless 无 renderer.texture → textureSources 安全降级为 0');
  assert(mem.textureMemoryMB === 0, 'headless 纹理内存估算安全降级为 0');

  const timer = setInterval(() => {
    for (const cb of [...listeners]) cb();
  }, 1);
  const report = await perf.runFpsBenchmark(20, 10);
  clearInterval(timer);
  assert(report.frames > 0, `报告包含帧采样（实际 ${report.frames} 帧）`);
  assert(report.frames < 1000, `每帧只采样一次，无同帧递归（实际 ${report.frames} 帧）`);
  assert(report.fps.avg === 60, `FPS 均值=60（模拟 ticker，实际 ${report.fps.avg}）`);
  assert(report.fps.min === 60 && report.fps.max === 60 && report.fps.p95 === 60, 'FPS min/max/p95 统计正确');
  assert(report.met55 === true, 'met55 判定（avg≥55 且 p95≥55）');
  assert(report.memory.baseline.jsHeapMB === 0, '非 Chromium 环境 JS 堆返回 0（不报错）');
  assert(report.memory.final.sprites === 100, '最终内存快照 sprites=100');
  assert(report.devices['refining_unit'] === 100, `设备类型统计 refining_unit=100（实际 ${report.devices['refining_unit']}）`);
  assert(report.durationMs >= 20, `采样窗口时长 ≥20ms（实际 ${report.durationMs}ms）`);
}

// ───────────────────────── 总结 ─────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`T1.10 验证: ${passed} 通过, ${failed} 失败`);
console.log('='.repeat(60));
if (failed > 0) {
  process.exit(1);
}
