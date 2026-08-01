// 入口文件 — T1.2 相机 + T1.3 资源 + T1.4 世界网格 + T1.5 视图操作 + T1.6 渲染 + T1.7 设备放置 + T1.8 基础交互 + T1.9 设备删除 + T1.10 性能基准
// 依据: implementation-phase-1.md T1.2 / T1.3 / T1.4 / T1.5 / T1.6 / T1.7 / T1.8 / T1.9 / T1.10
//   - 中键拖拽平移 / WASD 平移(屏幕相对) / 滚轮以鼠标为中心缩放
//   - 边缘滚动 (T1.5): 鼠标到窗口边缘自动平移，8 方向，与 WASD 叠加
//   - Ctrl+R 视图旋转 (T1.5): 顺时针 90°，4 态循环，以屏幕中心为枢轴
//   - 启动时加载 devices/items/ui 三图集 (T1.3)
//   - 世界网格: 浅灰背景 #E6E4E4 + 网格线 #D6D4D4 64px + 边缘渐隐 + 暗角 (T1.4)
//            旋转感知 (T1.5): 网格线随视图旋转正确投影到屏幕
//   - 渲染系统 (T1.6): ECS 实体(Position+SpriteComp) ↔ PixiJS Sprite 绑定 + 视口剔除
//   - 设备放置 (T1.7): 工具栏选设备 → 左键放网格交叉点 → R 键旋转预览(相对视图) → 右键/ESC 取消
//   - 基础交互 (T1.8): 左键点设备=选中(白色选中框) → 点空白=取消；选中框跟随相机
//   - 设备删除 (T1.9): 选中设备 + Delete 键 → 销毁实体 + 释放 footprint 占用；无选中按 Delete 无反应
//   - 性能基准 (T1.10): 一键 100 设备（真实放置路径）+ FPS/JS堆/GPU纹理内存统计
//   - 世界边界 (A11 WV-003 §4.4): 尺寸来自 MapInstance（不再读全局常量）

import { Application, Text } from 'pixi.js';
import { Game } from './game/Game';
import { CameraController } from './game/render/CameraController';
import { SceneRenderer } from './game/render/SceneRenderer';
import { GridRenderer } from './game/render/GridRenderer';
import { loadAllAssets, getTexture } from './game/render/AssetsLoader';
import { InventoryUI } from './game/ui/InventoryUI';
import { getBuildingDefinition, type BuildingDefinition } from './game/data/buildings';
import type { Direction } from './game/components/BuildingComp';
import { SelectionSystem } from './game/systems/SelectionSystem';
import { DeleteSystem } from './game/systems/DeleteSystem';
import { PerfMonitor, type BenchmarkReport, type MemoryStressRound } from './game/perf/PerfMonitor';
import type { Position } from './game/components/Position';
import type { SpriteComp } from './game/components/SpriteComp';
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
    text: '中键拖拽: 平移  |  WASD/方向键: 平移(屏幕相对)  |  鼠标靠边: 边缘滚动  |  滚轮: 以鼠标为中心缩放  |  Ctrl+R: 视图旋转  |  左键点设备=选中(点空白取消)  |  选中+Delete=删除  |  T1.7: 工具栏选设备→左键放置→R旋转→右键/ESC取消',
    style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, fill: 0x444444 },
  });
  help.x = 10;
  help.y = 30;
  app.stage.addChild(help);

  // ── T1.7 设备放置: 工具栏 + 放置系统输入转发 ──
  const placement = game.placement;
  const occupancy = game.occupancy;

  // ── T1.10 性能基准: FPS + 内存（JS 堆 + GPU 纹理估算）──
  const perf = new PerfMonitor(app, game.world, game.renderSystem, occupancy);

  // ── T1.8 基础交互: 点击选中 + 屏幕空间选中框 ──
  const selection = new SelectionSystem(game.world, camera, scene.layers);

  // ── T1.9 设备删除: 选中 + Delete 键 → 销毁实体 + 释放占用 ──
  const deleteSystem = new DeleteSystem(game.world, occupancy);

  // 工具栏: 挂 overlayLayer(屏幕空间层 6)，钉死屏幕底部，不受 Ctrl+R/相机影响。
  // onSelect 回调 → 进入放置模式 + 高亮选中按钮。
  const inventoryUI = new InventoryUI(app.renderer, getTexture, (id: string) => {
    const def = getBuildingDefinition(id);
    if (!def) return;
    // enterMode 有 toggle 语义（同设备再点取消），用 placement 当前态决定高亮
    const wasPlacingThis = placement.isPlacing() && placement.getCurrentDefinitionId() === id;
    placement.enterMode(def);
    inventoryUI.setActive(wasPlacingThis ? null : def.id);
  });
  inventoryUI.attachTo(scene.layers.overlayLayer);
  inventoryUI.layout(app.screen.width, app.screen.height);

  // ── 放置系统输入转发 ──
  // placement 不直接监听 DOM（避免与 CameraController 双监听冲突），由 main 转发。
  // 转换鼠标 clientX/Y → canvas 内屏幕坐标。
  const toCanvasPos = (e: { clientX: number; clientY: number }) => {
    const rect = app.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // 鼠标移动: 更新预览跟随位置 + 鼠标是否在 canvas 内
  const onPointerMoveMain = (e: PointerEvent): void => {
    const p = toCanvasPos(e);
    const tol = 2;
    const inside =
      p.x >= -tol && p.y >= -tol &&
      p.x <= app.canvas.clientWidth + tol &&
      p.y <= app.canvas.clientHeight + tol;
    placement.setMouse(p.x, p.y, inside);
  };
  // 鼠标按下: 放置态 → 左键(0)=确认放置, 右键(2)=取消；
  //           非放置态 → 左键(0)转发给 T1.8 选中系统（pointerdown 只记录，pointerup 提交）。
  // 中键(1)留给相机拖拽（CameraController 处理），不转发。
  //
  // ⚠️ 工具栏区域排除: 点击工具栏按钮（选设备）时，不能误触发地图放置。
  //   InventoryUI 按钮 pointerdown 调了 PixiJS 的 stopPropagation，但那只挡 PixiJS 事件系统
  //   内的冒泡；本监听是加在 app.canvas 上的原生 DOM 监听，两者是独立事件流。
  //   故此处用 InventoryUI 的屏幕包围盒判断：落在工具栏上的点击不转发（放置/选中都不转发）。
  const onPointerDownMain = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 2) return;
    const p = toCanvasPos(e);
    // 落在工具栏上 → 不转发（让 InventoryUI 的 PixiJS 事件处理按钮选中）
    const bar = inventoryUI.container.getBounds();
    if (p.x >= bar.x && p.x <= bar.x + bar.width && p.y >= bar.y && p.y <= bar.y + bar.height) {
      return;
    }
    if (placement.isPlacing()) {
      placement.onPointerDown(p.x, p.y, e.button);
      // 放置后或取消后，若退出了 placing 态，清除工具栏高亮
      if (!placement.isPlacing()) inventoryUI.setActive(null);
      return; // 放置点击不进入选中逻辑
    }
    if (e.button === 0) {
      // 非放置态左键 → T1.8 选中（pointerdown 记录时间戳+命中设备，pointerup 提交）
      selection.onPointerDown(p.x, p.y, e.button, performance.now());
    }
  };
  // 鼠标抬起: 只处理左键，挂在 window 上（松开时指针可能已移出 canvas）。
  //   T1.8 pointerup 结构（前瞻约束）——
  //   pointerdown 记了时间戳+命中设备，这里判定"短按 → 选中/取消"。
  //   放置态/工具栏的 pointerdown 未进入 selection（无 pending），此处天然 no-op。
  //   从 canvas 外按下的 pointerup 也没有 pending，同样 no-op。
  const onPointerUpMain = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    selection.onPointerUp(performance.now());
  };
  app.canvas.addEventListener('pointermove', onPointerMoveMain);
  app.canvas.addEventListener('pointerdown', onPointerDownMain);
  window.addEventListener('pointerup', onPointerUpMain);

  // 键盘: 裸 KeyR(旋转预览) + Escape(取消放置)，仅在 placing 态响应。
  // CameraController 已拦截 Ctrl/Cmd+KeyR（视图旋转），裸 R 不触发视图旋转。
  // 这里加的是**额外的** keydown 监听，与 CameraController 的监听并存不冲突。
  const onKeyPlacing = (e: KeyboardEvent): void => {
    if (!placement.isPlacing()) return; // R 监听只在放置模式激活（用户强调别全局监听）
    if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      placement.onKeyDown('KeyR');
    } else if (e.code === 'Escape') {
      placement.onKeyDown('Escape');
      inventoryUI.setActive(null);
    }
  };
  window.addEventListener('keydown', onKeyPlacing);

  // 键盘: Delete 键 = 删除选中设备（T1.9）。只在**非放置态**响应——
  // 放置模式下 Delete 无动作，与"右键=取消放置"两套语义不重叠。
  // 无选中时 deleteBuilding(null) 返回 false，天然无反应。
  const onKeyDelete = (e: KeyboardEvent): void => {
    if (e.code !== 'Delete') return;
    if (placement.isPlacing()) return; // 放置态不响应删除
    if (deleteSystem.deleteBuilding(selection.getSelected())) {
      e.preventDefault();
      selection.clearSelection(); // 选中态清空，选中框消失
      game.update(); // 立即刷新一帧，让 Sprite 移除
    }
  };
  window.addEventListener('keydown', onKeyDelete);

  // ── 主循环 (A5 §2: PixiJS Ticker) ──
  // HUD 文本节流（T1.10 性能注意）: PixiJS Text 每帧改 text 会重渲染文本纹理，
  // 4Hz 更新足够展示 FPS/内存趋势，避免文本重绘挤占 100 设备基准的帧预算。
  let lastHudUpdateAt = 0;
  let lastHudText = '';
  app.ticker.add((ticker) => {
    // 每帧轮询视口尺寸变化(绕开 resize 事件时序竞争)
    if (app.screen.width !== lastScreenW || app.screen.height !== lastScreenH) {
      lastScreenW = app.screen.width;
      lastScreenH = app.screen.height;
      const size = { width: lastScreenW, height: lastScreenH };
      camera.setViewport(size);
      gridRenderer.setViewport(size);
      inventoryUI.layout(lastScreenW, lastScreenH); // T1.7: 工具栏重排
    }
    controller.update(ticker.deltaMS);
    camera.update(ticker.deltaMS); // 视图旋转过渡动画（必须在 updateTransform 之前）
    camera.updateTransform();
    gridRenderer.update();
    placement.update(ticker.deltaMS); // T1.7: 放置预览跟随鼠标
    selection.update(); // T1.8: 选中框跟随相机（每帧重绘）
    game.update(); // T1.6: RenderSystem（实体↔Sprite 同步 + 视口剔除）
    // 选中框屏幕坐标（调试用）: 相机移动时该坐标应随之变化；若钉住不动即异常
    const now = performance.now();
    if (now - lastHudUpdateAt >= 250) {
      lastHudUpdateAt = now;
      const boxTL = selection.getSelected() !== null ? selection.getBoxTopLeft() : null;
      const mem = perf.sampleMemory();
      const heapTxt = mem.jsHeapMB > 0 ? `${mem.jsHeapMB.toFixed(1)}MB` : 'n/a';
      const text =
        `FPS: ${Math.round(ticker.FPS)}` +
        `  |  JS堆 ${heapTxt}` +
        `  |  纹理 ${mem.textureMemoryMB.toFixed(1)}MB(${mem.textureSources})` +
        `  |  Sprite ${mem.visibleSprites}/${mem.sprites}` +
        `  |  cam(${camera.x.toFixed(0)}, ${camera.y.toFixed(0)})` +
        `  zoom=${camera.zoom.toFixed(2)}${camera.isZooming ? '↗' : ''}` +
        `  rot=${camera.viewRotation}°` +
        `  |  实体=${game.world.entityCount()}` +
        (boxTL ? `  |  选中=设备@(${boxTL.x},${boxTL.y})` : '') +
        (placement.isPlacing()
          ? `  |  放置: ${placement.getCurrentDefinitionId()} (R=旋转, 左键=放, 右键/ESC=取消)`
          : '');
      if (text !== lastHudText) {
        lastHudText = text;
        hud.text = text;
      }
    }
  });

  // 首帧立即对齐一次相机变换 + 网格 + 渲染系统，避免首帧错位/缺帧
  camera.updateTransform();
  gridRenderer.update();
  placement.update(0);
  selection.update();
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

  // ── T1.7 验收钩子: 程序化放置 / 查询占用 ──
  // placeAt(defId, gx, gy, dir?): 在指定网格坐标放置设备（绕过鼠标交互，便于自动验收）。
  //   返回 true=放置成功。占用检查走真实 OccupancyMap.canPlace。
  const placeAt = (
    defId: string, gx: number, gy: number, dir: Direction = 0,
  ): boolean => {
    const def: BuildingDefinition | undefined = getBuildingDefinition(defId);
    if (!def) { console.warn(`placeAt: 未知设备 id '${defId}'`); return false; }
    const { w, h } = def.footprint;
    if (!occupancy.canPlace(gx, gy, w, h)) {
      console.warn(`placeAt: (${gx},${gy}) ${w}×${h} 无法放置（越界或占用冲突）`);
      return false;
    }
    const handle = game.world.createEntity();
    game.world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    game.world.addComponent(handle, 'BuildingComp', { definitionId: def.id, direction: dir, state: 'idle' });
    game.world.addComponent(handle, 'SpriteComp', {
      group: 'devices', textureKey: def.texture,
      width: w * CELL_SIZE, height: h * CELL_SIZE, layer: 2,
    });
    occupancy.occupyFootprint(gx, gy, def, dir);
    game.update();
    return true;
  };
  // getOccupiedCells(): 返回占用快照（验收"占位无泄漏"用）
  const getOccupiedCells = () => occupancy.snapshot();
  // clearAllPlaced(): 销毁所有带 BuildingComp 的实体 + 清空占用表（重置用）
  const clearAllPlaced = (): void => {
    const handles = game.world.query('BuildingComp');
    for (const h of handles) game.world.destroyEntity(h);
    occupancy.clear();
    selection.clearSelection(); // 实体清空后选中框必须消失（T1.9 删除同样依赖此路径）
    game.update();
    console.log(`[T1.7] 清除全部已放置设备 (${handles.length} 个)，占用表清空`);
  };

  // ── T1.8 验收钩子: 程序化选中第一个设备（绕过鼠标交互，便于自动验收）──
  // 走与真实鼠标相同的 pointerdown → pointerup 短按路径，不直接改内部状态。
  const selectFirstBuilding = (): boolean => {
    const handles = game.world.query('BuildingComp');
    if (handles.length === 0) {
      console.warn('selectFirstBuilding: 没有任何已放置设备');
      return false;
    }
    const h = handles[0];
    const pos = game.world.getComponent<Position>(h, 'Position')!;
    const spr = game.world.getComponent<SpriteComp>(h, 'SpriteComp')!;
    const screen = camera.worldToScreen(pos.x + spr.width / 2, pos.y + spr.height / 2);
    const t0 = performance.now();
    selection.onPointerDown(screen.x, screen.y, 0, t0);
    selection.onPointerUp(t0 + 10); // 10ms < 300ms = 短按
    selection.update(); // 立即画一次选中框
    return selection.getSelected() !== null;
  };

  // ── T1.9 验收钩子: 删除当前选中的设备（走与真实 Delete 键相同的逻辑路径）──
  const deleteSelectedBuilding = (): boolean => {
    const ok = deleteSystem.deleteBuilding(selection.getSelected());
    if (ok) {
      selection.clearSelection();
      game.update();
    }
    return ok;
  };

  // ── T1.10 验收钩子: 一键 100 设备（真实放置路径）+ FPS/内存 benchmark ──
  // 设备类型: Phase 1 定义中唯一带真实图集纹理的是 refining_unit（3×3，含
  // billboard logo 子 Sprite），用它压测最严苛；随机落点 + 占用检查保证不重叠。
  const BENCH_DEF_ID = 'refining_unit' as const;
  const spawnBenchmarkDevices = (n = 100): number => {
    const def = getBuildingDefinition(BENCH_DEF_ID);
    if (!def) { console.warn(`spawnBenchmarkDevices: 找不到 ${BENCH_DEF_ID}`); return 0; }
    const { w, h } = def.footprint;
    const maxGx = Math.max(0, MAP.widthCells - w);
    const maxGy = Math.max(0, MAP.heightCells - h);
    let placed = 0;
    let attempts = 0;
    const maxAttempts = n * 200 + 2000; // 随机拒绝采样上限（3×3 密度下足够）
    while (placed < n && attempts < maxAttempts) {
      attempts++;
      const gx = Math.floor(Math.random() * (maxGx + 1));
      const gy = Math.floor(Math.random() * (maxGy + 1));
      if (placeAt(BENCH_DEF_ID, gx, gy)) placed++;
    }
    console.log(`[T1.10] 一键生成 ${placed}/${n} 个 ${BENCH_DEF_ID}（${attempts} 次尝试）`);
    return placed;
  };

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** FPS/内存采样报告（不生成设备，先 spawnBenchmarkDevices 再调用）。 */
  const runFpsBenchmark = (durationMs = 5000): Promise<BenchmarkReport> =>
    perf.runFpsBenchmark(durationMs);

  /** 内存压测: 反复 生成100 → 清空，验证 Sprite/占用无泄漏、堆内存不持续增长。 */
  const memoryStressCheck = async (cycles = 3): Promise<MemoryStressRound[]> => {
    const results: MemoryStressRound[] = [];
    for (let i = 0; i < cycles; i++) {
      clearAllPlaced();
      await sleep(400); // 等上一轮 Sprite 销毁 + GC 尘埃落定
      const before = perf.sampleMemory();
      const placed = spawnBenchmarkDevices(100);
      await sleep(600); // 渲染稳定后采样
      const during = perf.sampleMemory();
      clearAllPlaced();
      await sleep(400);
      const after = perf.sampleMemory();
      results.push({
        cycle: i + 1,
        placed,
        before,
        during,
        after,
        heapAfterDeltaMB: Math.round((after.jsHeapMB - before.jsHeapMB) * 10) / 10,
      });
      console.log(
        `[T1.10 内存压测] 第${i + 1}轮: 生成${placed}个, ` +
        `堆 ${before.jsHeapMB}MB → ${during.jsHeapMB}MB → 清空后 ${after.jsHeapMB}MB ` +
        `(净增 ${(after.jsHeapMB - before.jsHeapMB).toFixed(1)}MB), ` +
        `纹理 ${during.textureMemoryMB.toFixed(1)}MB(${during.textureSources})`,
      );
    }
    return results;
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
    placement,
    occupancy,
    inventoryUI,
    selection,
    deleteSystem,
    getTexture,
    spawnTestDevices,
    clearTestDevices,
    placeAt,
    getOccupiedCells,
    clearAllPlaced,
    selectFirstBuilding,
    deleteSelectedBuilding,
    perf,
    getMemoryStats: () => perf.sampleMemory(),
    spawnBenchmarkDevices,
    runFpsBenchmark,
    memoryStressCheck,
  };

  console.log('[集成工业系统] T1.7 设备放置 + T1.8 基础交互 + T1.9 设备删除 + T1.10 性能基准就绪');
  console.log(`  世界: ${MAP.widthCells}×${MAP.heightCells} cells (MapInstance), CELL_SIZE=${CELL_SIZE}`);
  console.log('  操作: 中键拖拽/WASD(屏幕相对)/边缘滚动 平移, 滚轮以鼠标为中心缩放, Ctrl+R 视图旋转');
  console.log('  放置: 底部工具栏选设备 → 左键放网格 → R 旋转(相对视图) → 右键/ESC 取消');
  console.log('  交互: 左键点设备=选中(黄色填充+白色选中框), 点空白=取消, 选中+Delete=删除');
  console.log('  验收: __game.placeAt("refining_unit",5,5) 放设备 → selectFirstBuilding() 选中 → deleteSelectedBuilding() 删除 → getOccupiedCells() 查占用');
  console.log('  T1.10: __game.spawnBenchmarkDevices(100) 一键100设备 → runFpsBenchmark() 采样FPS/内存 → memoryStressCheck() 内存压测');
}

main().catch((err) => {
  console.error('[集成工业系统] 初始化失败:', err);
});
