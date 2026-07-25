// 入口文件 — T1.2 相机 + T1.3 资源 + T1.4 世界网格 + T1.5 视图操作
// 依据: implementation-phase-1.md T1.2 / T1.3 / T1.4 / T1.5
//   - 中键拖拽平移 / WASD 平移(屏幕相对) / 滚轮以鼠标为中心缩放 / 边界 64×64
//   - 边缘滚动 (T1.5): 鼠标到窗口边缘自动平移，8 方向，与 WASD 叠加
//   - Ctrl+R 视图旋转 (T1.5): 顺时针 90°，4 态循环，以屏幕中心为枢轴
//   - 启动时加载 devices/items/ui 三图集 (T1.3)
//   - 世界网格: 浅灰背景 #E6E4E4 + 网格线 #D6D4D4 64px + 边缘渐隐 + 暗角 (T1.4)
//            旋转感知 (T1.5): 网格线随视图旋转正确投影到屏幕

import { Application, Text } from 'pixi.js';
import { Camera } from './game/render/Camera';
import { CameraController } from './game/render/CameraController';
import { SceneRenderer } from './game/render/SceneRenderer';
import { GridRenderer } from './game/render/GridRenderer';
import { loadAllAssets, getTexture } from './game/render/AssetsLoader';

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

  // ── 相机 (先于网格创建，网格依赖相机) ──
  const camera = new Camera({ width: app.screen.width, height: app.screen.height });
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
    hud.text =
      `FPS: ${Math.round(ticker.FPS)}` +
      `  |  cam(${camera.x.toFixed(0)}, ${camera.y.toFixed(0)})` +
      `  zoom=${camera.zoom.toFixed(2)}` +
      `  rot=${camera.viewRotation}°`;
  });

  // 首帧立即对齐一次相机变换 + 网格，避免首帧错位
  camera.updateTransform();
  gridRenderer.update();

  // 开发期调试钩子: 暴露关键对象到 window，便于控制台验证与测试。
  (window as unknown as { __game: unknown }).__game = {
    app,
    camera,
    controller,
    gridRenderer,
    getTexture,
  };

  console.log('[集成工业系统] T1.5 视图操作就绪');
  console.log(`  世界: ${64}×${64} cells, CELL_SIZE=64`);
  console.log('  操作: 中键拖拽/WASD(屏幕相对)/边缘滚动 平移, 滚轮以鼠标为中心缩放, Ctrl+R 视图旋转');
}

main().catch((err) => {
  console.error('[集成工业系统] 初始化失败:', err);
});
