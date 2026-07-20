// 入口文件 — Phase 0: Hello World 验证
import { Application, Text, Graphics, Container } from 'pixi.js';

async function main() {
  const app = new Application();

  await app.init({
    width: 1280,
    height: 720,
    resizeTo: window,
    background: '#0a0a0a',
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  document.body.appendChild(app.canvas);

  // 标题
  const title = new Text({
    text: '集成工业系统',
    style: {
      fontFamily: 'system-ui, sans-serif',
      fontSize: 48,
      fill: 0xffffff,
      stroke: { color: 0x333333, width: 2 },
    },
  });
  title.anchor.set(0.5);
  title.x = app.screen.width / 2;
  title.y = app.screen.height / 2 - 60;

  // 副标题
  const subtitle = new Text({
    text: 'PixiJS v8 + Tauri 2.x · 渲染管线验证通过',
    style: {
      fontFamily: 'system-ui, sans-serif',
      fontSize: 18,
      fill: 0x888888,
    },
  });
  subtitle.anchor.set(0.5);
  subtitle.x = app.screen.width / 2;
  subtitle.y = app.screen.height / 2 + 20;

  // 装饰性网格线 (Graphics 测试)
  const grid = new Graphics();
  const gridSize = 64;
  for (let x = 0; x < app.screen.width; x += gridSize) {
    grid.moveTo(x, 0).lineTo(x, app.screen.height).stroke({ width: 1, color: 0x1a1a1a });
  }
  for (let y = 0; y < app.screen.height; y += gridSize) {
    grid.moveTo(0, y).lineTo(app.screen.width, y).stroke({ width: 1, color: 0x1a1a1a });
  }

  // 一个示例设备图标 (简单熔炉)
  const device = new Graphics();
  device.rect(600, 380, 80, 80)
    .fill({ color: 0x222222 })
    .stroke({ width: 2, color: 0x666666 });
  device.rect(610, 370, 60, 10)
    .fill({ color: 0x444444 })
    .stroke({ width: 1, color: 0x666666 });
  device.circle(640, 430, 16)
    .fill({ color: 0xff6600, alpha: 0.6 })
    .stroke({ width: 1, color: 0xff8800 });

  // FPS 计数器
  const fpsText = new Text({
    text: 'FPS: --',
    style: {
      fontFamily: 'monospace',
      fontSize: 14,
      fill: 0x00ff00,
    },
  });
  fpsText.x = 10;
  fpsText.y = 10;

  app.ticker.add((ticker) => {
    fpsText.text = `FPS: ${Math.round(ticker.FPS)} | Entities: 0`;
  });

  // 场景容器
  const scene = new Container();
  scene.addChild(grid, device, title, subtitle, fpsText);
  app.stage.addChild(scene);

  console.log('[集成工业系统] PixiJS v8 渲染管线初始化完成');
  console.log(`  屏幕: ${app.screen.width}x${app.screen.height}`);
  console.log(`  渲染器: ${app.renderer.name}`);
}

main().catch(console.error);
