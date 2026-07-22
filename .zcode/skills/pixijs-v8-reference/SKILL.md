---
name: pixijs-v8-reference
description: PixiJS v8 完整参考手册。覆盖 Application 初始化、场景图 (Container/Sprite/Graphics/Text)、资源加载、Ticker 帧循环、性能优化、ParticleContainer 粒子系统。用于工厂建造+塔防游戏 (ECS架构) 开发。
license: MIT
agent_created: true
---

# PixiJS v8 参考手册

> 面向工厂建造 + 塔防游戏的 PixiJS v8 API 速查。基于官方 25 个 AI Skills 提炼。

## 目录
- [Application 应用初始化](#1-application)
- [Container 场景图](#2-container)
- [Sprite 精灵](#3-sprite)
- [Graphics 矢量绘制](#4-graphics)
- [Text / BitmapText 文本](#5-text)
- [Assets 资源加载](#6-assets)
- [Ticker 帧循环](#7-ticker)
- [Performance 性能优化](#8-performance)
- [ParticleContainer 粒子](#9-particlecontainer)
- [ECS 集成模式](#10-ecs-集成模式)

---

## 1. Application

v8 使用异步初始化模式：

```ts
import { Application } from 'pixi.js';

const app = new Application();  // 构造函数无参数

await app.init({
  width: 1280,
  height: 720,
  resizeTo: window,           // 自适应窗口
  background: '#1a1a2e',
  antialias: true,
  preference: 'webgl',        // 'webgl' | 'webgpu'
  autoDensity: true,
  resolution: window.devicePixelRatio,
  autoStart: false,           // 手动控制渲染循环
});

document.body.appendChild(app.canvas);  // v8: app.canvas (不是 app.view)
```

**关键注意**：
- 不要在 `await app.init()` 之前访问 `app.canvas` / `app.renderer` / `app.screen`
- 销毁时使用 `app.destroy({},{ children: true, texture: true, textureSource: true })`
- 若同页签重建，必须 `releaseGlobalResources: true`

---

## 2. Container

场景图的核心节点，可包含子节点。所有变换属性向下传递。

```ts
const group = new Container({
  label: 'enemy-layer',      // v8: label 替代 name
  x: 100, y: 200,
  sortableChildren: true,    // 启用 zIndex 排序
  isRenderGroup: true,       // GPU 批量变换
});

// 子节点管理
parent.addChild(a, b, c);
parent.removeChild(sprite);
sprite.removeFromParent();   // 自分离

// 按标签查找
const obj = world.getChildByLabel('player');

// zIndex 排序
ground.zIndex = 0;   // 底层
player.zIndex = 10;  // 中层
ui.zIndex = 100;     // 顶层
```

**警告**：Sprite/Graphics/Text 是叶子节点，不能添加子节点！

---

## 3. Sprite

显示图像的叶子节点。

```ts
const texture = await Assets.load('furnace.png');
const sprite = new Sprite({
  texture,
  anchor: 0.5,         // { x: 0.5, y: 0.5 }
  tint: 0xcccccc,
  x: 400, y: 300,
});
app.stage.addChild(sprite);
```

**纹理图集**：使用 spritesheet 合并纹理，一个图集 = 一个 GPU 纹理 → 减少 draw call。

---

## 4. Graphics

v8 新工作流：先绘形状，后填样式。**不是** v7 的 `beginFill/drawRect/endFill`。

```ts
const g = new Graphics();

// 矩形 + 填充 + 描边
g.rect(0, 0, 64, 64)
  .fill({ color: 0x333333, alpha: 1 })
  .stroke({ width: 2, color: 0x000000 });

// 圆形
g.circle(32, 32, 16).fill(0xff0000);

// 圆角矩形
g.roundRect(0, 0, 128, 64, 8).fill(0x2ecc71);

// 挖孔 (替代 v7 beginHole/endHole)
g.rect(0, 0, 100, 100).fill(0x00ff00);
g.circle(50, 50, 20).cut();

// GraphicsContext 共享 (避免重复 GPU 几何体)
const ctx = new GraphicsContext().rect(0, 0, 50, 50).fill(0xff0000);
const g1 = new Graphics(ctx);
const g2 = new Graphics(ctx);  // 共享几何体
```

**性能提示**：Graphics 适合静态图。动态内容应转为纹理后以 Sprite 使用。

### SVG 导出 (v8.18.0+)

```ts
import { graphicsContextToSvg } from 'pixi.js';
const svgString = graphicsContextToSvg(g.context);
```

---

## 5. Text

```ts
// 静态文本 (标题/菜单)
const title = new Text({
  text: '集成工业系统',
  style: {
    fontFamily: 'Arial',
    fontSize: 36,
    fill: 0xffffff,
    stroke: { color: 0x000000, width: 3 },
  },
});

// 动态文本 (分数/计时器) — 用 BitmapText！
const scoreText = new BitmapText({
  text: 'Score: 0',
  style: { fontFamily: 'Arial', fontSize: 24, fill: 0xffffff },
});
// 每帧更新 BitmapText.text 几乎零开销
app.ticker.add(() => { scoreText.text = `Score: ${score}`; });
```

**关键规则**：
- **不要**每帧更新 `Text.text` → 会导致 Canvas 重绘 + GPU 上传
- 每帧变化的文本用 `BitmapText`
- 所有文本类都是叶子节点

---

## 6. Assets

```ts
await Assets.init({ basePath: '/assets/' });

// 单文件加载
const texture = await Assets.load('furnace.png');

// 批量加载 (带进度)
const assets = await Assets.load(['belt.png', 'turret.png', 'enemy.png'], {
  onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
});

// 按别名加载
await Assets.load({ alias: 'furnace', src: 'furnace.svg' });
const tex = Assets.get('furnace');

// 关卡切换时释放
Assets.unloadBundle('level1');
```

**禁止**：不要用 `Texture.from(url)` 加载，v8 中它只读缓存。先用 `Assets.load()`。

---

## 7. Ticker

```ts
app.ticker.add((ticker) => {
  // deltaTime: 无量纲，60fps ≈ 1.0 (用于动画乘法)
  sprite.rotation += 0.05 * ticker.deltaTime;

  // deltaMS: 实际毫秒数 (用于基于时间的计算)
  enemy.x += speed * (ticker.deltaMS / 1000);
});

// 优先级
import { UPDATE_PRIORITY } from 'pixi.js';
app.ticker.add(updatePhysics, this, UPDATE_PRIORITY.HIGH);    // 先执行
app.ticker.add(updateRender, this, UPDATE_PRIORITY.LOW);       // 后执行

// 手动循环 (用于 ECS 架构)
await app.init({ autoStart: false });
function gameLoop() {
  ecsWorld.update(ticker.deltaMS);
  app.ticker.update();
  app.render();
  requestAnimationFrame(gameLoop);
}
```

---

## 8. Performance

### 对象池 (必须用！)

```ts
class ObjectPool {
  private pool: Sprite[] = [];

  acquire(parent: Container, texture: Texture): Sprite {
    let obj = this.pool.pop();
    if (!obj) {
      obj = new Sprite(texture);
      parent.addChild(obj);
    }
    obj.visible = true;
    obj.texture = texture;
    return obj;
  }

  release(obj: Sprite): void {
    obj.visible = false;
    this.pool.push(obj);
  }
}
```

### 批处理优化
```
差: Sprite, Graphics, Sprite, Graphics → 4 draw calls
好: Sprite, Sprite, Graphics, Graphics → 2 draw calls
```
**同类对象集中排列**，减少 GPU draw call。

### cacheAsTexture
```ts
// 静态 UI 缓存为纹理
panel.cacheAsTexture(true);

// 复杂 Graphics 转纹理用 Sprite
const tex = app.renderer.generateTexture(complexGraphics);
const sprite = new Sprite(tex);
```

### 其他关键规则
- 精灵表 > 独立纹理 (减少批次中断)
- `BitmapText` > `Text` (动态内容)
- 销毁时 `releaseGlobalResources: true`
- 批量销毁纹理时分帧执行 (每帧 ~5 个)

---

## 9. ParticleContainer

适用于大量同纹理精灵 (子弹、粒子、资源掉落)。

```ts
const texture = await Assets.load('particle.png');

const container = new ParticleContainer({
  texture,
  boundsArea: new Rectangle(0, 0, 1920, 1080),  // 必须设置！
  dynamicProperties: {
    position: true,   // 每帧变的属性才设为 true
    rotation: false,
    color: false,
  },
  maxSize: 10000,
});

// 创建粒子
for (let i = 0; i < 5000; i++) {
  container.addParticle(new Particle({
    texture,
    x: Math.random() * 1920,
    y: Math.random() * 1080,
    alpha: 0.8,
  }));
}

app.stage.addChild(container);

// 批量更新
container.particleChildren.forEach(p => { p.x += 1; });
container.update();  // 更新 GPU buffer
```

**限制**：ParticleContainer 不支持 addChild(Sprite)，只能用 addParticle(Particle)。

---

## 10. ECS 集成模式

本项目采用轻量 ECS + PixiJS 渲染的架构：

```ts
// 初始化
const app = new Application();
await app.init({ autoStart: false });
const ecsWorld = new World();
const spriteMap = new Map<Entity, Sprite>();

// 渲染系统
class RenderSystem {
  update(world: World): void {
    const entities = world.query('Position', 'SpriteComp');
    for (const entity of entities) {
      const pos = world.getComponent<Position>(entity, 'Position')!;
      const sprite = spriteMap.get(entity);
      if (sprite) {
        sprite.x = pos.x;
        sprite.y = pos.y;
      }
    }
  }
}

// 游戏循环
app.ticker.add(() => {
  const dt = app.ticker.deltaMS;
  beltSystem.update(ecsWorld, dt);     // 分帧处理
  machineSystem.update(ecsWorld, dt);
  turretSystem.update(ecsWorld, dt);
  renderSystem.update(ecsWorld);
});
```

**分帧处理**：传送带/机器系统每帧只处理 N 个，避免卡顿：
```ts
class BeltSystem {
  private currentIndex = 0;
  private readonly BATCH_SIZE = 50;

  update(world: World, dt: number): void {
    const entities = world.query('Belt', 'Position');
    const end = Math.min(this.currentIndex + this.BATCH_SIZE, entities.length);
    for (let i = this.currentIndex; i < end; i++) {
      this.processBelt(world, entities[i], dt);
    }
    this.currentIndex = end >= entities.length ? 0 : end;
  }
}
```

---

## v7 → v8 迁移速查

| v7 | v8 | 说明 |
|---|---|---|
| `new Application({...})` | `new Application(); await app.init({...})` | 异步初始化 |
| `app.view` | `app.canvas` | 更名 |
| `.name` | `.label` + `getChildByLabel()` | 更名 |
| `beginFill/drawRect/endFill` | `rect().fill().stroke()` | 新工作流 |
| `drawCircle` | `circle` | 去掉 draw 前缀 |
| `beginHole/endHole` | `.cut()` | 挖孔 |
| `cacheAsBitmap` | `cacheAsTexture(true)` | 更名 |
| `Texture.from()` | `await Assets.load(); Assets.get()` | 只读缓存 vs 加载 |
| `document.body.appendChild(app.view)` | `document.body.appendChild(app.canvas)` | 更名 |
