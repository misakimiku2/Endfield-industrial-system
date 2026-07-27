// 入口文件 — T1.2 相机 + T1.3 资源 + T1.4 世界网格 + T1.5 视图操作 + T1.6 渲染系统
// 依据: implementation-phase-1.md T1.2 / T1.3 / T1.4 / T1.5 / T1.6
//   - 中键拖拽平移 / WASD 平移(屏幕相对) / 滚轮以鼠标为中心缩放
//   - 边缘滚动 (T1.5): 鼠标到窗口边缘自动平移，8 方向，与 WASD 叠加
//   - Ctrl+R 视图旋转 (T1.5): 顺时针 90°，4 态循环，以屏幕中心为枢轴
//   - 启动时加载 devices/items/ui 三图集 (T1.3)
//   - 世界网格: 浅灰背景 #E6E4E4 + 网格线 #D6D4D4 64px + 边缘渐隐 + 暗角 (T1.4)
//            旋转感知 (T1.5): 网格线随视图旋转正确投影到屏幕
//   - 渲染系统 (T1.6): ECS 实体(Position+SpriteComp) ↔ PixiJS Sprite 绑定 + 视口剔除
//   - 世界边界 (A11 WV-003 §4.4): 尺寸来自 MapInstance（不再读全局常量）

import { Application, Text } from 'pixi.js';
import { Game } from './game/Game';
import { CameraController } from './game/render/CameraController';
import { SceneRenderer } from './game/render/SceneRenderer';
import { GridRenderer } from './game/render/GridRenderer';
import { loadAllAssets, getTexture } from './game/render/AssetsLoader';
import { CELL_SIZE } from './game/render/constants';
import type { EntityHandle } from './game/ECS';

async function main() {
  const app = new Application();
  await app.init({
    width: 1280,
    height: 720,
    resizeTo: window,
    background: '#0a0a0a', // 视口外的区域（世界小于视口时可见）
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  document.body.appendChild(app.canvas);

  // ── 场景图层搭建 (A2 §4) ──
  const scene = new SceneRenderer(app);

  // ── Game: ECS World + WorldData(含 MapInstance) + Camera + RenderSystem ──
  // 相机的世界边界取自 worldData.map（A11 WV-003 §4.4）。
  const game = new Game(scene, { width: app.screen.width, height: app.screen.height });
  const camera = game.camera;
  camera.bindWorldContainer(scene.layers.worldContainer);

  // ── T1.4 世界网格: 背景底色 + 网格线 + 边缘渐隐 + 暗角 ──
  const gridRenderer = new GridRenderer(
    scene.layers.backgroundLayer,
    scene.layers.overlayLayer,
    camera,
    { width: app.screen.width, height: app.screen.height },
  );

  // ── 相机输入 ──
  const controller = new CameraController(camera, app.canvas);

  // ── 视口尺寸同步: 每帧轮询 app.screen，而非监听 window resize ──
  // PixiJS 的 ResizePlugin 在 window resize 时异步更新 app.screen，与本监听
  // 存在时序竞争 (可能读到旧值)。改为每帧轮询检测变化，下一帧必然捕获到新值，
  // 彻底消除最大化/还原时 viewport 与 transform 不同步导致的画面错位。
  let lastScreenW = app.screen.width;
  let lastScreenH = app.screen.height;

  // ── T1.3: 加载纹理图集 (devices/items/ui) ──
  await loadAllAssets();

  // T1.3 验收: 控制台确认关键纹理可取、无 404
  const sampleDevice = getTexture('devices', 'transport_belt');
  const sampleItem = getTexture('items', 'cuprium_ore');
  const sampleUi = getTexture('ui', 'close_button');
  console.log('[T1.3 验收] 纹理检查:',
    'devices/transport_belt =', sampleDevice ? `✓ ${sampleDevice.width}×${sampleDevice.height}` : '✗ 缺失',
    '| items/cuprium_ore =', sampleItem ? `✓ ${sampleItem.width}×${sampleItem.height}` : '✗ 缺失',
    '| ui/close_button =', sampleUi ? `✓ ${sampleUi.width}×${sampleUi.height}` : '✗ 缺失',
  );

  // ── HUD: 相机状态 + 操作提示 ──
  const hud = new Text({
    text: '',
    style: { fontFamily: 'monospace', fontSize: 13, fill: 0x00cc00 },
  });
  hud.x = 10;
  hud.y = 10;
  app.stage.addChild(hud);

  const help = new Text({
    text: '中键拖拽: 平移  |  WASD/方向键: 平移(屏幕相对)  |  鼠标靠边: 边缘滚动  |  滚轮: 以鼠标为中心缩放  |  Ctrl+R: 视图旋转',
    style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, fill: 0x444444 },
  });
  help.x = 10;
  help.y = 30;
  app.stage.addChild(help);

  // ── 主循环 (A5 §2: PixiJS Ticker) ──
  app.ticker.add((ticker) => {
    // 每帧轮询视口尺寸变化(绕开 resize 事件时序竞争)
    if (app.screen.width !== lastScreenW || app.screen.height !== lastScreenH) {
      lastScreenW = app.screen.width;
      lastScreenH = app.screen.height;
      const size = { width: lastScreenW, height: lastScreenH };
      camera.setViewport(size);
      gridRenderer.setViewport(size);
    }
    controller.update(ticker.deltaMS);
    camera.update(ticker.deltaMS); // 视图旋转过渡动画（必须在 updateTransform 之前）
    camera.updateTransform();
    gridRenderer.update();
    game.update(); // T1.6: RenderSystem（实体↔Sprite 同步 + 视口剔除）
    hud.text =
      `FPS: ${Math.round(ticker.FPS)}` +
      `  |  cam(${camera.x.toFixed(0)}, ${camera.y.toFixed(0)})` +
      `  zoom=${camera.zoom.toFixed(2)}` +
      `  rot=${camera.viewRotation}°` +
      `  |  实体=${game.world.entityCount()}`;
  });

  // 首帧立即对齐一次相机变换 + 网格 + 渲染系统，避免首帧错位/缺帧
  camera.updateTransform();
  gridRenderer.update();
  game.update();

  // ── T1.6 验收用的测试钩子: 控制台生成/清除测试设备 ──
  // spawnTestDevices(n): 随机位置创建 n 个带 Position+SpriteComp 的实体（验证创建→Sprite 出现）
  // clearTestDevices():   销毁全部测试实体（验证销毁→Sprite 自动消失）
  const TEST_HANDLES: EntityHandle[] = [];
  const MAP = game.worldData.map;
  // 设备尺寸（cells）×CELL_SIZE = 世界像素；纹理用真实图集 key
  const TEST_SPRITES = [
    { group: 'devices', textureKey: 'refining_unit', cells: 3 },    // 3×3 精炼炉
    { group: 'devices', textureKey: 'transport_belt', cells: 1 },   // 1×1 传送带
    { group: 'devices', textureKey: 'depot', cells: 1 },            // 1×1 仓库
  ] as const;
  const spawnTestDevices = (n: number): void => {
    for (let i = 0; i < n; i++) {
      const def = TEST_SPRITES[i % TEST_SPRITES.length];
      const w = def.cells * CELL_SIZE;
      const h = def.cells * CELL_SIZE;
      // 随机位置，吸附到格子，保证不越界（留 footprint 余量）
      const maxGx = Math.max(0, MAP.widthCells - def.cells);
      const maxGy = Math.max(0, MAP.heightCells - def.cells);
      const gx = Math.floor(Math.random() * (maxGx + 1));
      const gy = Math.floor(Math.random() * (maxGy + 1));
      const handle = game.world.createEntity();
      game.world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
      game.world.addComponent(handle, 'SpriteComp', {
        group: def.group, textureKey: def.textureKey, width: w, height: h, layer: 2,
      });
      TEST_HANDLES.push(handle);
    }
    game.update(); // 立即刷新一帧，让 Sprite 出现
    console.log(`[T1.6 测试] 生成 ${n} 个设备，当前实体数=${game.world.entityCount()}`);
  };
  const clearTestDevices = (): void => {
    for (const h of TEST_HANDLES) game.world.destroyEntity(h);
    TEST_HANDLES.length = 0;
    game.update();
    console.log(`[T1.6 测试] 清除全部测试设备，当前实体数=${game.world.entityCount()}`);
  };

  // 开发期调试钩子: 暴露关键对象到 window，便于控制台验证与测试。
  (window as unknown as { __game: unknown }).__game = {
    app,
    game,
    world: game.world,
    worldData: game.worldData,
    camera,
    controller,
    gridRenderer,
    renderSystem: game.renderSystem,
    getTexture,
    spawnTestDevices,
    clearTestDevices,
  };

  console.log('[集成工业系统] T1.6 渲染系统就绪');
  console.log(`  世界: ${MAP.widthCells}×${MAP.heightCells} cells (MapInstance), CELL_SIZE=${CELL_SIZE}`);
  console.log('  操作: 中键拖拽/WASD(屏幕相对)/边缘滚动 平移, 滚轮以鼠标为中心缩放, Ctrl+R 视图旋转');
  console.log('  验收: 控制台 __game.spawnTestDevices(10) 生成测试设备, clearTestDevices() 清除');
}

main().catch((err) => {
  console.error('[集成工业系统] 初始化失败:', err);
});
