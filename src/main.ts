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
import { deviceReadoutText } from './game/ui/DeviceReadout';
import { BUILDING_DEFINITIONS, getBuildingDefinition, createOutputPollQueue, type BuildingDefinition } from './game/data/buildings';
import type { BuildingComp, BufferSlot, Direction } from './game/components/BuildingComp';
import { loadItemRegistry } from './game/data/items';
import { parseRecipeCsv, buildRecipeIndex, formatRecipeSummary } from './game/data/recipes';
import { createBufferSlots, tryAcceptItem, consumeFromSlot, formatBufferSlots } from './game/systems/machine/BufferOps';
import { portStatuses, type PortStatus } from './game/systems/machine/PortStatusOps';
import recipeCsvText from '../doc/csv/recipe.csv?raw';
import resourceCsvText from '../doc/csv/终末地资源列表 - 自然资源.csv?raw';
import { SelectionSystem } from './game/systems/SelectionSystem';
import { DeleteSystem } from './game/systems/DeleteSystem';
import { deleteChain, deleteSegment, queryChain } from './game/systems/belt/BeltChainOps';
import { BeltSelection } from './game/systems/belt/BeltSelection';
import { PerfMonitor, type BenchmarkReport, type MemoryStressRound } from './game/perf/PerfMonitor';
import type { Position } from './game/components/Position';
import type { SpriteComp } from './game/components/SpriteComp';
import type { BeltSegmentComp } from './game/components/BeltSegmentComp';
import { BeltSystem } from './game/systems/BeltSystem';
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
  const game = new Game(scene, { width: app.screen.width, height: app.screen.height }, app.renderer);
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
    text: '中键拖拽: 平移  |  WASD/方向键: 平移(屏幕相对)  |  鼠标靠边: 边缘滚动  |  滚轮: 以鼠标为中心缩放  |  Ctrl+R: 视图旋转  |  E: 传送带创建模式  |  左键点设备=选中(点空白取消)  |  选中+Delete=删除  |  T1.7: 工具栏选设备→左键放置→R旋转→右键/ESC取消',
    style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, fill: 0x444444 },
  });
  help.x = 10;
  help.y = 30;
  app.stage.addChild(help);

  // ── T2.9b: 选中设备最小读数（**临时件**，T2.15 弹窗落地时吸收移除）──
  // 屏幕空间层单个 Pixi Text（不随 Ctrl+R 视图旋转），4Hz 节流（T1.10 先例）。
  // 非生产设备（仓库口无任何槽位）deviceReadoutText 返回 null → 隐藏。
  // 明确不做: 弹窗容器/多行排版/图标/进度条/样式——全部留给 T2.15。
  const readout = new Text({
    text: '',
    style: { fontFamily: 'monospace', fontSize: 14, fill: 0x1a5fb4 },
  });
  readout.x = 10;
  readout.y = 52;
  readout.visible = false;
  app.stage.addChild(readout);

  // ── T1.7 设备放置: 工具栏 + 放置系统输入转发 ──
  const placement = game.placement;
  const occupancy = game.occupancy;

  // ── T1.10 性能基准: FPS + 内存（JS 堆 + GPU 纹理估算）──
  const perf = new PerfMonitor(app, game.world, game.renderSystem, occupancy);

  // ── T1.8 基础交互: 点击选中 + 屏幕空间选中框 ──
  // 传送带选中态共享对象：SelectionSystem 每帧写，带身渲染器（白边/隐指针/屏幕常量斜杠）读。
  const beltSelection = new BeltSelection();
  const selection = new SelectionSystem(game.world, camera, scene.layers, beltSelection);
  game.renderSystem.setBeltSelection(beltSelection);

  // ── T1.9 设备删除: 选中 + Delete 键 → 销毁实体 + 释放占用 ──
  const deleteSystem = new DeleteSystem(game.world, occupancy);

  // ── T2.0 传送带创建系统 ──
  const belt = game.beltCreation;

  // 工具栏: 挂 overlayLayer(屏幕空间层 6)，钉死屏幕底部，不受 Ctrl+R/相机影响。
  // onSelect 回调 → 进入放置模式 + 高亮选中按钮。
  const inventoryUI = new InventoryUI(app.renderer, getTexture, (id: string) => {
    const def = getBuildingDefinition(id);
    if (!def) return;
    // 切到设备放置模式时，先退出传送带创建模式，避免两套模式冲突
    if (belt.isActive()) {
      belt.exitMode();
      selection.clearSelection();
    }
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
    belt.setMouse(p.x, p.y, inside);
    game.renderSystem.setBeltHoverMouse(p.x, p.y, inside);
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
    // 传送带创建模式优先：左键选起点/确认，右键退出
    if (belt.isActive()) {
      belt.onPointerDown(p.x, p.y, e.button);
      return;
    }
    if (placement.isPlacing()) {
      placement.onPointerDown(p.x, p.y, e.button);
      // 放置后或取消后，若退出了 placing 态，清除工具栏高亮
      if (!placement.isPlacing()) inventoryUI.setActive(null);
      return; // 放置点击不进入选中逻辑
    }
    if (e.button === 0) {
      // 非放置态左键 → 选中（pointerdown 记录时间戳+命中+修饰键，pointerup 提交）。
      // Shift=范围连选、Ctrl=点选切换（SelectionSystem.onPointerUp 按 mods 分支）。
      selection.onPointerDown(p.x, p.y, e.button, performance.now(), { shift: e.shiftKey, ctrl: e.ctrlKey });
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

  // 键盘: E 键进入/退出传送带创建模式。
  // 放置模式激活时不响应，避免两套模式冲突。
  const onKeyBeltMode = (e: KeyboardEvent): void => {
    if (e.code !== 'KeyE' || e.ctrlKey || e.metaKey) return;
    if (placement.isPlacing()) return;
    e.preventDefault();
    belt.toggleMode();
    // hover 的 enabled 改由主循环每帧按 belt.isActive() 同步（见 ticker），此处不再手动设，
    // 避免 ESC/右键退出创建模式时漏调 setBeltHoverEnabled(true) 导致 hover 永久禁用。
    if (belt.isActive()) {
      selection.clearSelection();
      inventoryUI.setActive(null);
    }
  };
  window.addEventListener('keydown', onKeyBeltMode);

  // 键盘: 传送带创建模式下 Escape 落盘当前预览（若有）再退出，与右键一致。
  const onKeyBeltEscape = (e: KeyboardEvent): void => {
    if (e.code !== 'Escape') return;
    if (!belt.isActive()) return;
    e.preventDefault();
    belt.onKeyDown('Escape');
  };
  window.addEventListener('keydown', onKeyBeltEscape);

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

  // 键盘: Delete 键 = 删除选中目标（T1.9 设备 / T2.0 传送带）。只在**非放置态**响应——
  // 放置模式下 Delete 无动作，与"右键=取消放置"两套语义不重叠。
  //   - 传送带整链选中 → 整链删除；单格选中 → 单段删除（下游重拆为断头链）
  //   - 设备选中 → 走 deleteBuilding（保持 T1.9 行为）
  // 无选中时各删除函数返回 false/null，天然无反应。
  const onKeyDelete = (e: KeyboardEvent): void => {
    if (e.code !== 'Delete') return;
    if (placement.isPlacing()) return; // 放置态不响应删除
    // 传送带：删除所有选中段（多选批量；逐个 deleteSegment，下游自动重拆为断头链）
    const beltHandles = beltSelection.getHandles();
    if (beltHandles.length > 0) {
      e.preventDefault();
      for (const h of beltHandles) {
        if (game.world.isAlive(h)) deleteSegment(game.world, occupancy, h);
      }
      selection.clearSelection(); // 选中态清空，链高亮消失
      game.update(); // 立即刷新一帧，让带身 Graphics 移除
      return;
    }
    // 设备
    if (deleteSystem.deleteBuilding(selection.getSelected())) {
      e.preventDefault();
      selection.clearSelection();
      game.update();
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
    belt.update(ticker.deltaMS); // T2.0: 传送带创建模式高亮/预览刷新
    // 每帧同步 hover 启用态：创建模式（E 进 / ESC / 右键 任一方式）下禁用 hover，
    // 普通模式下启用。集中在此同步，避免分散在各退出入口导致漏调（曾使 hover 永久禁用）。
    game.renderSystem.setBeltHoverEnabled(!belt.isActive());
    selection.update(); // T1.8: 选中框跟随相机（每帧重绘）
    game.tickSimulation(ticker.deltaMS); // T2.1: 仿真 Tick(20TPS，驱动 BeltSystem 物品移动)，须在渲染前
    game.update(ticker.deltaMS); // T1.6: RenderSystem（实体↔Sprite 同步 + 视口剔除 + T2.0 pointer 流动）
    // 选中框屏幕坐标（调试用）: 相机移动时该坐标应随之变化；若钉住不动即异常
    const now = performance.now();
    if (now - lastHudUpdateAt >= 250) {
      lastHudUpdateAt = now;
      const devHandle = selection.getSelected();
      const chainSel = selection.getSelectedChain();
      const boxTL = selection.getBoxTopLeft();
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
        (devHandle !== null && boxTL ? `  |  选中=设备@(${boxTL.x},${boxTL.y})` : '') +
        (chainSel && boxTL
          ? `  |  选中=传送带${chainSel.wholeChain ? '链' : '段'}@(${boxTL.x},${boxTL.y}) ` +
            `${chainSel.wholeChain ? queryChain(game.world, chainSel.chainId).length + '段' : '单段'} [Delete=删除]`
          : '') +
        (placement.isPlacing()
          ? `  |  放置: ${placement.getCurrentDefinitionId()} (R=旋转, 左键=放, 右键/ESC=取消)`
          : '') +
        (belt.isActive()
          ? `  |  传送带模式: 点击蓝色高亮起点 → 移动鼠标预览 → 左键落盘 (右键/ESC/E=退出)`
          : '');
      if (text !== lastHudText) {
        lastHudText = text;
        hud.text = text;
      }
      // T2.9b 读数（临时件）: 选中设备的缓冲区单行读数；仓库口等无槽位设备 → null 隐藏
      let readoutTxt: string | null = null;
      if (devHandle !== null && game.world.isAlive(devHandle)) {
        const comp = game.world.getComponent<BuildingComp>(devHandle, 'BuildingComp');
        const def = comp ? getBuildingDefinition(comp.definitionId) : undefined;
        if (comp && def) readoutTxt = deviceReadoutText(comp, def);
      }
      if (readoutTxt !== null) {
        if (readout.text !== readoutTxt) readout.text = readoutTxt;
        readout.visible = true;
      } else {
        readout.visible = false;
      }
    }
  });

  // ── 后台标签页仿真保活 (A5 §2 双时钟的兜底) ──
  // Pixi ticker(rAF) 在隐藏/被遮挡的标签页停转 → 仅靠它驱动时工厂仿真整体冻结
  // （T2.5 实测: 在后台标签页跑 __game.test("t25")，设备注入原料后永远 idle、进度 0%）。
  // 定时器兜底: document.hidden 时按**实际流逝时间**喂 tickSimulation——浏览器后台节流
  // ~1Hz 也能按真实间隔追上（accumulator 钳制 SIM_ACCUMULATOR_MAX_MS=1000，每次最多
  // 追 20 Tick，不崩溃；长时间深度节流时仿真慢放但不冻结）。渲染仍由 rAF 驱动
  // （后台无需渲染），回到前台自动恢复双时钟。可见时仅刷新时间戳，无仿真开销。
  let lastHiddenTickAt = performance.now();
  setInterval(() => {
    if (!document.hidden) {
      lastHiddenTickAt = performance.now();
      return;
    }
    const now = performance.now();
    game.tickSimulation(now - lastHiddenTickAt);
    lastHiddenTickAt = now;
  }, 250);

  // 首帧立即对齐一次相机变换 + 网格 + 渲染系统，避免首帧错位/缺帧
  camera.updateTransform();
  gridRenderer.update();
  placement.update(0);
  belt.update(0);
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
  // placeAt(defId, gx, gy, dir?, quiet?): 在指定网格坐标放置设备（绕过鼠标交互，便于自动验收）。
  //   返回 true=放置成功。占用检查走真实 OccupancyMap.canPlace。
  //   quiet=true 时失败不打 console.warn（批量/采样放置用，避免刷屏；手动调用默认 false 保留提示）。
  const placeAt = (
    defId: string, gx: number, gy: number, dir: Direction = 0,
    quiet = false,
  ): boolean => {
    const def: BuildingDefinition | undefined = getBuildingDefinition(defId);
    if (!def) {
      if (!quiet) console.warn(`placeAt: 未知设备 id '${defId}'`);
      return false;
    }
    const { w, h } = def.footprint;
    if (!occupancy.canPlace(gx, gy, w, h)) {
      if (!quiet) console.warn(`placeAt: (${gx},${gy}) ${w}×${h} 无法放置（越界或占用冲突）`);
      return false;
    }
    const handle = game.world.createEntity();
    game.world.addComponent(handle, 'Position', { x: gx * CELL_SIZE, y: gy * CELL_SIZE });
    game.world.addComponent(handle, 'BuildingComp', {
      definitionId: def.id, direction: dir, state: 'idle',
      paused: false, // T2.8: 玩家手动暂停（默认运行中）
      bufferInput: createBufferSlots(def.inputSlotCount), // T2.4: 放置即建输入缓冲区
      bufferOutput: createBufferSlots(def.outputSlotCount), // T2.5: 输出缓冲区（一槽一物）
      inputPollIndex: 0, // T2.10: 输入轮询指针从定义序首口（左）开始
      outputPollQueue: createOutputPollQueue(def), // T2.10: 输出轮询队列=全部输出端口按定义序
      currentRecipeId: null, progress: 0, elapsed: 0, // T2.5: 生产计时字段（放置时无任务）
    });
    game.world.addComponent(handle, 'SpriteComp', {
      group: 'devices', textureKey: def.texture,
      width: w * CELL_SIZE, height: h * CELL_SIZE, layer: 2,
      logoTextureKey: def.logoTextureKey, // 与 PlacementSystem 落盘一致: 挂载 billboard logo（精炼炉完整显示）
    });
    occupancy.occupyFootprint(gx, gy, def, dir);
    game.update();
    return true;
  };
  // getOccupiedCells(): 返回占用快照（验收"占位无泄漏"用）
  const getOccupiedCells = () => occupancy.snapshot();
  // clearAllPlaced(): 销毁所有带 BuildingComp 的实体 + 传送带段 + 清空占用表（重置用）
  // T2.2: 一并清除 BeltSegmentComp（原仅清设备，传送带会累积 → "一堆物品"bug）
  const clearAllPlaced = (): void => {
    const buildings = game.world.query('BuildingComp');
    const belts = game.world.query('BeltSegmentComp');
    for (const h of buildings) game.world.destroyEntity(h);
    for (const h of belts) game.world.destroyEntity(h);
    occupancy.clear();
    selection.clearSelection(); // 实体清空后选中框必须消失（T1.9 删除同样依赖此路径）
    game.update();
    console.log(`[T1.7] 清除全部放置物 (设备 ${buildings.length} + 传送带 ${belts.length})，占用表清空`);
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

  // ── T2.0 验收钩子: 程序化选中第一个传送带段（绕过鼠标，走真实 pointerdown→up 短按路径）──
  // doubleClick=false → 单击选单格（白边+斜杠+隐指针）; =true → 连续两次短按选整条链。
  const selectFirstBelt = (doubleClick = false): boolean => {
    const handles = game.world.query('BeltSegmentComp');
    if (handles.length === 0) {
      console.warn('selectFirstBelt: 没有任何传送带段');
      return false;
    }
    const h = handles[0];
    const pos = game.world.getComponent<Position>(h, 'Position')!;
    const spr = game.world.getComponent<SpriteComp>(h, 'SpriteComp')!;
    const screen = camera.worldToScreen(pos.x + spr.width / 2, pos.y + spr.height / 2);
    const t0 = performance.now();
    selection.onPointerDown(screen.x, screen.y, 0, t0);
    selection.onPointerUp(t0 + 10); // 10ms < 300ms = 短按
    if (doubleClick) {
      // 模拟双击：紧接第二次短按同段（间隔 20ms < DOUBLE_CLICK_MS=350）→ 升级整链
      const t1 = t0 + 20;
      selection.onPointerDown(screen.x, screen.y, 0, t1);
      selection.onPointerUp(t1 + 10);
    }
    selection.update(); // 立即刷新选中态 + 高亮
    return selection.getSelectedChain() !== null;
  };

  // ── T2.0 验收钩子: 删除当前选中的传送带（走与真实 Delete 键相同的逻辑路径）──
  // 整链选中→整链删；单格选中→单段删（下游重拆为断头链）。
  const deleteSelectedBelt = (): boolean => {
    const chain = selection.getSelectedChain();
    if (!chain) return false;
    if (chain.wholeChain) {
      deleteChain(game.world, occupancy, chain.chainId);
    } else {
      deleteSegment(game.world, occupancy, chain.handle);
    }
    selection.clearSelection();
    game.update();
    return true;
  };

  // ── T1.10 验收钩子: 一键 100 设备（真实放置路径）+ FPS/内存 benchmark ──
  // 设备类型: Phase 1 定义中唯一带真实图集纹理的是 refining_unit（3×3，含
  // billboard logo 子 Sprite），用它压测最严苛；随机落点 + 占用检查保证不重叠。
  const BENCH_DEF_ID = 'refining_unit' as const;
  const spawnBenchmarkDevices = (n = 100): number => {
    const def = getBuildingDefinition(BENCH_DEF_ID);
    if (!def) { console.warn(`spawnBenchmarkDevices: 找不到 ${BENCH_DEF_ID}`); return 0; }
    // 一键语义: 每次执行先清空已有设备，再生成正好 n 台。
    // （旧版是累加式，重复执行会把 100 台不断叠加上去，用户反馈刷屏）
    clearAllPlaced();
    // 安全上限: 64×64 地图最多容纳 ~455 台 3×3 设备；n 超出 500 直接钳制，
    // 避免误传超大 n 导致拒绝采样循环跑很久。
    const safeN = Math.min(Math.max(1, Math.floor(n)), 500);
    const { w, h } = def.footprint;
    const maxGx = Math.max(0, MAP.widthCells - w);
    const maxGy = Math.max(0, MAP.heightCells - h);
    // 随机打乱全部候选锚点后贪心放置: 与"随机分布"等价，但没有失败重试，
    // 不会触发 placeAt 的失败 warn（旧实现每次失败都打日志，控制台刷屏 + 页面卡顿）。
    const anchors: { gx: number; gy: number }[] = [];
    for (let gx = 0; gx <= maxGx; gx++) {
      for (let gy = 0; gy <= maxGy; gy++) anchors.push({ gx, gy });
    }
    for (let i = anchors.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [anchors[i], anchors[j]] = [anchors[j], anchors[i]];
    }
    let placed = 0;
    for (const a of anchors) {
      if (placed >= safeN) break;
      if (placeAt(BENCH_DEF_ID, a.gx, a.gy, 0, true)) placed++;
    }
    console.log(`[T1.10] 一键生成 ${placed}/${safeN} 个 ${BENCH_DEF_ID}（候选锚点 ${anchors.length} 个，已先清空旧设备）`);
    return placed;
  };

  /**
   * 铺满模式: 64×64 地图按 3×3 网格密铺（21×21 = 441 台，零缝隙），
   * 21:9 宽屏观感/满载性能测试用。随机打乱放置顺序保持观感变化。
   */
  const fillBenchmarkDevices = (): number => {
    const def = getBuildingDefinition(BENCH_DEF_ID);
    if (!def) { console.warn('fillBenchmarkDevices: 找不到精炼炉定义'); return 0; }
    clearAllPlaced();
    const { w, h } = def.footprint;
    const cols = Math.floor(MAP.widthCells / w); // 21
    const rows = Math.floor(MAP.heightCells / h); // 21
    const anchors: { gx: number; gy: number }[] = [];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) anchors.push({ gx: i * w, gy: j * h });
    }
    for (let i = anchors.length - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1));
      [anchors[i], anchors[k]] = [anchors[k], anchors[i]];
    }
    let placed = 0;
    for (const a of anchors) {
      if (placeAt(BENCH_DEF_ID, a.gx, a.gy, 0, true)) placed++;
    }
    console.log(`[T1.10] 铺满模式: ${placed} 台（${cols}×${rows} 网格密铺，已先清空旧设备）`);
    return placed;
  };

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  /** 日志时间前缀 HH:MM:SS（控制台日志按时间线阅读用，T2.5 用户反馈）。 */
  const ts = (): string => new Date().toTimeString().slice(0, 8);

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

  // ── T2.0 验收钩子: 程序化创建一条传送带链（用于目视验证直段/转角/4方向渲染）──
  // 用法: __game.spawnBelt([[5,5],[8,5],[8,8]], 0)
  //   cells: [[gx,gy],...] 网格序列（首格为起点）
  //   startDir: 起点进入方向（0/90/180/270），决定首格转角判断；直链传 0 即可
  const spawnBelt = (
    cells: Array<[number, number]>,
    startDir: 0 | 90 | 180 | 270 = 0,
  ): number => {
    const path = cells.map(([x, y]) => ({ x, y }));
    if (path.length < 1) return 0;
    const chainId = `chain-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // 计算每格出方向
    const dirCells = path.map((c, i) => {
      let dir: 0 | 90 | 180 | 270;
      if (i < path.length - 1) {
        const n = path[i + 1];
        const dx = n.x - c.x, dy = n.y - c.y;
        dir = dx > 0 ? 0 : dx < 0 ? 180 : dy > 0 ? 90 : 270;
      } else if (i > 0) {
        const p = path[i - 1];
        const dx = c.x - p.x, dy = c.y - p.y;
        dir = dx > 0 ? 0 : dx < 0 ? 180 : dy > 0 ? 90 : 270;
      } else {
        dir = startDir;
      }
      return { ...c, direction: dir };
    });
    const chainIncoming = startDir;
    let created = 0;
    for (let i = 0; i < dirCells.length; i++) {
      const incomingDir = i === 0 ? chainIncoming : dirCells[i - 1].direction;
      const outgoingDir = dirCells[i].direction;
      const isCorner = incomingDir !== outgoingDir;
      // CW/CCW 判定
      const dirIdx = (d: number) => (d === 270 ? 0 : d === 0 ? 1 : d === 90 ? 2 : 3);
      const diff = (dirIdx(outgoingDir) - dirIdx(incomingDir) + 4) % 4;
      const isCCW = diff === 3;
      // T2.2: 占用检查，避免重复运行在同一格叠加多条传送带（测试累积 bug 修复）
      if (!occupancy.canPlace(dirCells[i].x, dirCells[i].y, 1, 1)) {
        console.warn(`spawnBelt: (${dirCells[i].x},${dirCells[i].y}) 已占用，跳过该格`);
        continue;
      }
      const handle = game.world.createEntity();
      game.world.addComponent(handle, 'Position', { x: dirCells[i].x * CELL_SIZE, y: dirCells[i].y * CELL_SIZE });
      game.world.addComponent(handle, 'SpriteComp', {
        group: 'devices',
        textureKey: isCorner ? 'belt_corner' : 'transport_belt',
        width: CELL_SIZE,
        height: CELL_SIZE,
        layer: 2,
      });
      game.world.addComponent(handle, 'BeltSegmentComp', {
        chainId,
        direction: outgoingDir as 0 | 90 | 180 | 270,
        isCorner,
        entryDir: isCorner ? (incomingDir as 0 | 90 | 180 | 270) : undefined,
        mirrorH: isCorner ? isCCW : undefined,
        isTail: i === dirCells.length - 1,
        incomingDirection: i === 0 ? chainIncoming : undefined,
        segmentIndex: i,
        phaseOffset: Math.random(),
        items: [], // T2.1: 物品队列初始为空
        blocked: false,
      });
      occupancy.occupy(dirCells[i].x, dirCells[i].y, 'transport_belt');
      created++;
    }
    game.update(); // 立即刷新一帧，让 Sprite 出现
    return created;
  };

  // ── T2.1 验收钩子: 程序化创建一段传送带并往首段注入物品（验收"单段物品移动"）──
  // 用法: __game.spawnBeltWithItem([[10,10]], 270, 'cuprium_ore')
  //   物品从首段段首(progress=0)出发，沿方向匀速移动(+0.025/tick，2秒走一格)，到段尾(0.99)停下。
  //   多格链: 物品只在首段内移动到段尾停（T2.1 不做跨段传输，留 T2.2）。
  //   itemId 见 items 图集，如 'cuprium_ore' / 'amethyst_ore' / 'ferrium_ore'。
  const spawnBeltWithItem = (
    cells: Array<[number, number]>,
    startDir: 0 | 90 | 180 | 270,
    itemId: string,
    progress = BeltSystem.beltPhase,
  ): number => {
    clearAllPlaced(); // T2.2: 每次清场，避免重复运行累积传送带/物品（修复"一堆物品"bug）
    const before = new Set(game.world.query('BeltSegmentComp'));
    const created = spawnBelt(cells, startDir);
    if (created === 0) return 0;
    // 在新增段中找链首段(segmentIndex===0)注入物品；退化取首个新增段
    const after = game.world.query('BeltSegmentComp');
    let head: EntityHandle | null = null;
    for (const h of after) {
      if (before.has(h)) continue;
      if (head === null) head = h; // 退化: 记住首个新增段
      const seg = game.world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp');
      if (seg && seg.segmentIndex === 0) { head = h; break; } // 优先链首段
    }
    if (head !== null) {
      const seg = game.world.getComponent<BeltSegmentComp>(head, 'BeltSegmentComp');
      // ECS getComponent 返回组件对象引用，直接 mutate 即生效（Phase 1 简化设计）
      // 默认 progress=BeltSystem.beltPhase：物品注入即与 pointer 同相位（"物品=实体 pointer"）
      if (seg) seg.items.push({ itemId, progress, delta: 0 });
    }
    game.update(); // 立即刷新一帧，让物品 Sprite 出现
    return created;
  };

  // ── T2.2 验收钩子: 消费链尾物品（模拟设备吸入/存货口，测试堵塞→疏通）──
  // 移除所有链尾断头段(isTail)的段尾物品(progress 最大)各一个。
  // 用法: 传送带链堵塞后调用 → 链尾腾位 → 下游 hasSpace 恢复 → 上游恢复流动。
  const consumeBeltTailItem = (): number => {
    const segs = game.world.query('BeltSegmentComp');
    let removed = 0;
    for (const h of segs) {
      const seg = game.world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp');
      if (!seg || !seg.isTail || !seg.items || seg.items.length === 0) continue;
      seg.items.sort((a, b) => b.progress - a.progress); // 段尾(出口)在前
      seg.items.shift(); // 移除段尾物品
      removed++;
    }
    game.update();
    return removed;
  };

  // ── T2.6 验收钩子: 往传送带段注入物品 / 查看段上物品状态 ──
  // injectBeltItem('originium_ore') → 往 segmentIndex===0 的段注入源矿。
  //   默认 progress=BeltSystem.beltPhase——与 spawnBeltWithItem 同约定（T2.1"物品=实体 pointer"）:
  //   物品注入即与 pointer 同相位，间距/节奏与指针动画完全一致；显式传 0 会随机错相
  //   （用户实测: 物品与指针间距每次不同、且从带首边缘外出现）。
  //   与 spawnBeltWithItem 不同: 不清场，可与已放置设备共存，
  //   T2.6 场景 = placeAt + spawnBelt + injectBeltItem。
  const injectBeltItem = (itemId: string, progress = BeltSystem.beltPhase, segmentIndex = 0): boolean => {
    for (const h of game.world.query('BeltSegmentComp')) {
      const seg = game.world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp');
      if (seg && seg.segmentIndex === segmentIndex) {
        seg.items.push({ itemId, progress, delta: 0 });
        game.update();
        return true;
      }
    }
    console.warn(`injectBeltItem: 找不到 segmentIndex===${segmentIndex} 的传送带段`);
    return false;
  };
  // beltStatus() → 每段一行: "段0 (6,10) 270° [尾]: 源矿@0.35, 蓝铁矿@0.10"（验收物品停在门口=0.50 用）
  const beltStatus = (): string => {
    const segs = game.world.query('BeltSegmentComp').map((h) => ({
      seg: game.world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp'),
      pos: game.world.getComponent<Position>(h, 'Position'),
    }));
    if (segs.length === 0) return '没有传送带段';
    return segs
      .map(({ seg, pos }) => {
        if (!seg || !pos) return '段?: 未知';
        const gx = Math.round(pos.x / CELL_SIZE);
        const gy = Math.round(pos.y / CELL_SIZE);
        const items = (seg.items ?? [])
          .map((it) => `${itemName(it.itemId)}${it.entering ? '(进设备中)' : ''}@${it.progress.toFixed(2)}`)
          .join(', ');
        return `段${seg.segmentIndex} (${gx},${gy}) ${seg.direction}°${seg.isTail ? ' [尾]' : ''}${seg.blocked === true ? ' [堵]' : ''}: ${items || '无物品'}`;
      })
      .join('\n');
  };

  // ── T2.3 验收钩子: 配方数据加载（启动时从 CSV 构建，控制台查询）──
  // listRecipes('refining_unit') → "精炼炉配方：晶体外壳(源矿×1, 2秒)、蓝铁块(蓝铁矿×1, 2秒)、..."
  const equipmentNameToId = new Map<string, string>();
  for (const def of Object.values(BUILDING_DEFINITIONS)) equipmentNameToId.set(def.name, def.id);
  const itemTable = loadItemRegistry(resourceCsvText, recipeCsvText);
  const recipeTable = parseRecipeCsv(recipeCsvText, itemTable, equipmentNameToId);
  if (recipeTable.skipped.length > 0) {
    console.warn(`[T2.3] 跳过 ${recipeTable.skipped.length} 条配方（设备未定义）:`,
      [...new Set(recipeTable.skipped.map((s) => s.detail))].join('、'));
  }
  const recipeIndex = buildRecipeIndex(recipeTable.recipes);
  const itemName = (id: string): string => itemTable.byId.get(id)?.name ?? id;
  const listRecipes = (equipmentId = 'refining_unit'): string => {
    const def = getBuildingDefinition(equipmentId);
    const list = recipeIndex.get(equipmentId) ?? [];
    return `${def?.name ?? equipmentId}配方：${list.map((r) => formatRecipeSummary(r, itemName)).join('、')}`;
  };

  // ── T2.5: 注入生产数据，注册 MachineSystem（BeltSystem 之后，DD-010）──
  // 生产事件转发 console（启动/结算/blocked 仅状态转换时产生，低频不刷屏；
  // T2.6 input 吸入 / T2.7 output 放出事件随物品吞吐节奏产生），
  // recentEvents 环形缓冲供 __game.productionLog() 覆盘验证。
  const machineSystem = game.initProduction(recipeIndex, itemTable);
  const eventTag = (e: { type: string }): string =>
    e.type === 'input' ? 'T2.6 物流' : e.type === 'output' ? 'T2.7 物流' : 'T2.5 生产';
  machineSystem.onEvent = (e) => {
    // T2.12 仓库口吞吐事件不转发控制台——无限源/汇随物品节奏持续产生（1件/2秒/口），
    // 转发必然刷屏；recentEvents 环形缓冲仍可经 __game.productionLog() 覆盘验证。
    if (e.type === 'depot-output' || e.type === 'depot-input') return;
    console.log(`[${ts()}] [${eventTag(e)}] ${e.message}`);
  };

  // ── T2.4 验收钩子: 输入缓冲区（模拟物品传入，检查 count 与锁定）──
  // injectInput('originium_ore', 3) → "输入槽0: 源矿 × 3/50 (已锁定)"
  const firstBuildingHandle = (): EntityHandle | null => {
    const handles = game.world.query('BuildingComp');
    return handles.length > 0 ? handles[0] : null;
  };
  const getBuffer = (h: EntityHandle | null): BufferSlot[] | null => {
    if (h === null || !game.world.isAlive(h)) return null;
    return game.world.getComponent<BuildingComp>(h, 'BuildingComp')?.bufferInput ?? null;
  };
  const bufferCapacityOf = (h: EntityHandle | null): number => {
    const comp = h !== null ? game.world.getComponent<BuildingComp>(h, 'BuildingComp') : null;
    return comp ? (getBuildingDefinition(comp.definitionId)?.bufferCapacity ?? 50) : 50;
  };
  const inputBuffer = (handle?: EntityHandle): string => {
    const h = handle ?? firstBuildingHandle();
    const buf = getBuffer(h);
    if (buf === null) return '没有已放置的设备';
    return formatBufferSlots(buf, bufferCapacityOf(h), itemName);
  };
  const injectInput = (itemId: string, count = 1, handle?: EntityHandle): string => {
    const h = handle ?? firstBuildingHandle();
    const buf = getBuffer(h);
    if (buf === null) return '没有已放置的设备';
    for (let i = 0; i < count; i++) {
      if (!tryAcceptItem(buf, itemId, bufferCapacityOf(h))) break;
    }
    game.update();
    return inputBuffer(h ?? undefined);
  };
  /** 从输入槽扣减 count 件（可选限定 itemId），扣空的槽解锁。返回是否有设备被处理。 */
  const consumeInput = (count = 1, itemId: string | null = null, handle?: EntityHandle): boolean => {
    const h = handle ?? firstBuildingHandle();
    const buf = getBuffer(h);
    if (buf === null) return false;
    let left = count;
    for (const slot of buf) {
      if (left <= 0) break;
      if (itemId !== null && slot.itemId !== itemId) continue;
      const take = Math.min(left, slot.count);
      if (take > 0) { consumeFromSlot(slot, take); left -= take; }
    }
    game.update();
    return true;
  };

  // ── T2.5 验收钩子: 生产计时/原子结算（控制台监控生产进度与槽变化）──
  // productionStatus() → "精炼炉: working | 配方: 晶体外壳 | 进度: 45.0% (900/2000ms) ..."
  const getOutputBuffer = (h: EntityHandle | null): BufferSlot[] | null => {
    if (h === null || !game.world.isAlive(h)) return null;
    return game.world.getComponent<BuildingComp>(h, 'BuildingComp')?.bufferOutput ?? null;
  };
  const productionStatus = (handle?: EntityHandle): string => {
    const h = handle ?? firstBuildingHandle();
    if (h === null || !game.world.isAlive(h)) return '没有已放置的设备';
    const comp = game.world.getComponent<BuildingComp>(h, 'BuildingComp');
    if (!comp) return '设备缺少 BuildingComp';
    const def = getBuildingDefinition(comp.definitionId);
    const cap = def?.bufferCapacity ?? 50;
    const recipe = comp.currentRecipeId !== null
      ? (recipeIndex.get(comp.definitionId) ?? []).find((r) => r.id === comp.currentRecipeId)
      : undefined;
    // T2.8: paused 是独立于状态机的玩家手动关停，与 LOGO 视觉（优先显示暂停图标）对照
    const stateLabel = comp.paused ? `${comp.state} (已暂停)` : comp.state;
    const head = recipe
      ? `${def?.name ?? comp.definitionId}: ${stateLabel} | 配方: ${formatRecipeSummary(recipe, itemName)} | 进度: ${(comp.progress * 100).toFixed(1)}% (${comp.elapsed}/${recipe.time}ms)`
      : `${def?.name ?? comp.definitionId}: ${stateLabel} | 无生产任务`;
    return [
      head,
      formatBufferSlots(comp.bufferInput, cap, itemName),
      formatBufferSlots(comp.bufferOutput, cap, itemName, '输出槽'),
    ].join('\n');
  };
  /** 查看输出缓冲区（格式同 inputBuffer）。 */
  const outputBuffer = (handle?: EntityHandle): string => {
    const h = handle ?? firstBuildingHandle();
    const buf = getOutputBuffer(h);
    if (buf === null) return '没有已放置的设备';
    return formatBufferSlots(buf, bufferCapacityOf(h), itemName, '输出槽');
  };
  /** 向输出槽注入产物（测 blocked：注满输出槽）。语义同输入槽锁定/合堆。 */
  const injectOutput = (itemId: string, count = 1, handle?: EntityHandle): string => {
    const h = handle ?? firstBuildingHandle();
    const buf = getOutputBuffer(h);
    if (buf === null) return '没有已放置的设备';
    for (let i = 0; i < count; i++) {
      if (!tryAcceptItem(buf, itemId, bufferCapacityOf(h))) break;
    }
    game.update();
    return outputBuffer(h ?? undefined);
  };
  /** 从输出槽扣减 count 件（模拟 T2.7 传送带取走产物，测 blocked→疏通）。 */
  const consumeOutput = (count = 1, itemId: string | null = null, handle?: EntityHandle): boolean => {
    const h = handle ?? firstBuildingHandle();
    const buf = getOutputBuffer(h);
    if (buf === null) return false;
    let left = count;
    for (const slot of buf) {
      if (left <= 0) break;
      if (itemId !== null && slot.itemId !== itemId) continue;
      const take = Math.min(left, slot.count);
      if (take > 0) { consumeFromSlot(slot, take); left -= take; }
    }
    game.update();
    return true;
  };
  /** 最近生产事件（start/settle/blocked/cancel/input/output…，验收控制台消息用）。
   *  portIndex 为 T2.10 轮询端口下标（input/output 事件带，其余 undefined）。 */
  const productionLog = (): Array<{ type: string; portIndex?: number; message: string }> =>
    machineSystem.recentEvents.map((e) => ({ type: e.type, portIndex: e.portIndex, message: e.message }));

  // ── T2.8 验收钩子: 玩家手动暂停 + 端口连接状态 ──
  // setPaused(bool, handle?): 置/清设备 paused（正式入口是 T2.15 弹窗电源开关，
  //   本钩子是 T2.8 阶段的驱动入口）。暂停 = 生产/物流视同离线，LOGO 换深灰暂停图标。
  const setPaused = (paused: boolean, handle?: EntityHandle): string => {
    const h = handle ?? firstBuildingHandle();
    if (h === null || !game.world.isAlive(h)) return '没有已放置的设备';
    const comp = game.world.getComponent<BuildingComp>(h, 'BuildingComp');
    if (!comp) return '设备缺少 BuildingComp';
    comp.paused = paused; // ECS 组件引用直接 mutate 即生效
    const def = getBuildingDefinition(comp.definitionId);
    console.log(`[T2.8] ${def?.name ?? comp.definitionId} ${paused ? '已暂停（LOGO→深灰暂停图标，计时停走、不再吞吐）' : '已恢复（LOGO 复原，从暂停处继续）'}`);
    return productionStatus(h);
  };
  /** 端口连接状态一览（渲染层 PortHighlightRenderer 同源判定: connected 黄 / blocked 红）。 */
  const formatPortStatus = (list: PortStatus[], label: string): string => {
    if (list.length === 0) return `  ${label}: (无)`;
    return `  ${label}: ` + list.map((p) => {
      const cell = `(${p.x},${p.y})`;
      if (!p.connected) return `${cell} 未连接`;
      return `${cell} ${p.blocked ? '●红(堵塞)' : '●黄(已连接)'}`;
    }).join('  ');
  };
  const portStatus = (handle?: EntityHandle): string => {
    const h = handle ?? firstBuildingHandle();
    if (h === null || !game.world.isAlive(h)) return '没有已放置的设备';
    const comp = game.world.getComponent<BuildingComp>(h, 'BuildingComp');
    if (!comp) return '设备缺少 BuildingComp';
    const def = getBuildingDefinition(comp.definitionId);
    if (!def) return '未知设备定义';
    const st = portStatuses(game.world, h, comp, def);
    // T2.10: 轮询状态与端口高亮同屏对照——指针指向下一个补货的输入口，
    // 队列是当前活跃的输出端口轮询序（未列出 = 堵塞集，恢复后自动追加队尾）。
    const nIn = st.input.length;
    const pollLine = nIn > 0
      ? `  输入轮询指针: 下一个=输入口${(comp.inputPollIndex % nIn) + 1}`
      : '  输入轮询指针: (无输入口)';
    const queueLine = st.output.length > 0
      ? `  输出轮询队列: ${comp.outputPollQueue.length > 0
        ? comp.outputPollQueue.map((i) => `输出口${i + 1}`).join('→')
        : '(空——全部输出口堵塞，恢复后追加队尾)'}`
      : '  输出轮询队列: (无输出口)';
    return [
      `${def.name} 端口状态（画面: 黄=已连接 红=堵塞; paused=${comp.paused}）:`,
      formatPortStatus(st.input, '输入'),
      formatPortStatus(st.output, '输出'),
      pollLine,
      queueLine,
    ].join('\n');
  };

  // ── 测试场景速建（implementation-phase-2.md「测试效率」章节的一键版）──
  // 控制台帮助行是文档（含 → 等非代码符号），整行粘贴会 SyntaxError；
  // 一键测试把验收流程封装成单条命令，非技术向用户只需复制一个调用。
  // __game.test('t25') → 自动: 放精炼炉 → 注源矿 → 监控计时(原料不变) → 结算续启
  //                      → 注满输出演示 blocked → consumeOutput 疏通恢复。
  const firstComp = (): BuildingComp | null => {
    const h = firstBuildingHandle();
    return h !== null ? game.world.getComponent<BuildingComp>(h, 'BuildingComp') ?? null : null;
  };
  const waitFor = async (pred: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      if (pred()) return true;
      await sleep(stepMs);
    }
    return pred();
  };
  /** T2.5 一键测试主体（并发/重复保护见 runTest 的 phase 状态机）。 */
  const demoT25 = async (): Promise<string> => {
    console.log(`[${ts()}] ════ T2.5 一键测试: 生产计时与生产循环 ════`);
    console.log('(T2.5 按计划无画面变化——设备状态 UI 在 T2.8/T2.9，效果全部看本控制台)');
    clearAllPlaced();
    if (!placeAt('refining_unit', 5, 5)) return 'T2.5 测试失败: 精炼炉放置失败';
    console.log(`[${ts()}] [步骤1] 已放置精炼炉，注入源矿 ×3 →`);
    injectInput('originium_ore', 3);
    await sleep(300);
    console.log(`[${ts()}] [步骤2] 启动生产计时（不扣原料）:\n${productionStatus()}`);
    const early = firstComp();
    if (early && early.state === 'idle' && early.currentRecipeId === null) {
      console.log(`[${ts()}] ⚠ 注入源矿后设备仍 idle——仿真时钟没有推进。已启用后台保活定时器；` +
        '若长时间无进展，请把游戏标签页切到前台（rAF 在后台标签页停转，深度节流时仿真会慢放）。');
    }
    await sleep(800);
    const mid = firstComp();
    if (mid) {
      console.log(
        `[${ts()}] [步骤3] 计时中 进度=${(mid.progress * 100).toFixed(0)}%，` +
        `输入槽仍为 源矿 ×${mid.bufferInput[0].count}（生产期间原料不变，A8 §3.1）`,
      );
    }
    // 等首次结算: 输出槽出现 1 个晶体外壳（结算后立即续启，state 回 working）
    const settled = await waitFor(() => {
      const c = firstComp();
      return c !== null && (c.bufferOutput[0]?.count ?? 0) >= 1;
    }, 4000);
    if (!settled) {
      console.log(`[${ts()}] T2.5 测试失败: 4 秒内未观察到结算——仿真时钟未推进（页面在后台被深度节流？切到前台再试）`);
      return 'T2.5 测试失败: 4 秒内未观察到结算（计时未推进，建议前台运行）';
    }
    console.log(`[${ts()}] [步骤4] 结算完成（上方 [T2.5 生产] 消息即控制台验收文本）:\n${productionStatus()}`);

    // blocked 演示: 注满输出 → 下次计时完成时结算暂缓 → 疏通后完成暂缓结算
    console.log(`[${ts()}] [步骤5] 注满输出槽演示 blocked（输出 ×50）→`);
    injectOutput('origocrust', 49); // 输出已有 1，补到 50
    const blocked = await waitFor(() => firstComp()?.state === 'blocked', 5000);
    if (!blocked) {
      console.log(`[${ts()}] T2.5 测试失败: 5 秒内未进入 blocked（计时/输出异常？）`);
      return 'T2.5 测试失败: 5 秒内未进入 blocked';
    }
    const bc = firstComp();
    console.log(
      `[${ts()}] [步骤6] blocked: 结算暂缓，原料未扣除（源矿仍 ×${bc?.bufferInput[0].count}）:\n${productionStatus()}`,
    );
    console.log(`[${ts()}] [步骤7] consumeOutput(1) 疏通（模拟 T2.7 传送带取走产物）→`);
    consumeOutput(1);
    await sleep(300);
    console.log(`[${ts()}] [步骤8] 疏通后完成暂缓结算并恢复生产:\n${productionStatus()}`);
    console.log(`[${ts()}] ════ T2.5 一键测试完成 ════`);
    return 'T2.5 一键测试完成（关键输出见控制台 [T2.5 生产] / [步骤N] 日志）';
  };

  /** 链尾段（isTail，物品"停在设备门口"的观察点）。 */
  const tailSegment = (): BeltSegmentComp | null => {
    for (const h of game.world.query('BeltSegmentComp')) {
      const seg = game.world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp');
      if (seg?.isTail) return seg;
    }
    return null;
  };
  /** 链尾段上 progress 最大的物品（队首）——null = 链尾无物品。 */
  const tailHeadItem = (): { itemId: string; progress: number } | null => {
    const tail = tailSegment();
    if (!tail || tail.items.length === 0) return null;
    return tail.items.reduce((a, b) => (b.progress > a.progress ? b : a));
  };
  /** T2.6 一键测试主体（并发/重复保护见 runTest 的 phase 状态机）。
   * 场景: 精炼炉(5,5) + 下方上行传送带×3（喂底中输入端口 6,7）。
   * 预注满输出槽使设备 blocked——生产结算暂缓、不消耗输入槽，本次验收只看输入对接，时序确定。
   * 吸入语义（2026-08-17 修订"预约制端口格中心"）: 物品走到供给格中心(0.5)预约
   * （输入槽即 +1）→ 继续前进走进设备半格 → 到端口格中心(1.5)消失。满槽停 0.5。 */
  const demoT26 = async (): Promise<string> => {
    console.log(`[${ts()}] ════ T2.6 一键测试: 传送带 → 设备输入对接（预约制·端口格中心吸入） ════`);
    clearAllPlaced();
    if (!placeAt('refining_unit', 5, 5)) return 'T2.6 测试失败: 精炼炉放置失败';
    injectOutput('origocrust', 50); // 输出注满 → 设备 blocked（结算暂缓，输入槽不被生产消耗）
    const created = spawnBelt([[6, 10], [6, 9], [6, 8]], 270);
    if (created !== 3) return 'T2.6 测试失败: 传送带创建失败';
    injectBeltItem('originium_ore');
    console.log(`[${ts()}] [步骤1] 场景就绪: 精炼炉(5,5) + 上行传送带×3 → 底中输入端口(6,7)，源矿已上带`);
    console.log(`[${ts()}] [步骤2] 观察画面: 物品沿传送带向上前进（约 6 秒到门口 0.5）→ 预约进槽 → 走进设备半格深处 → 到端口格中心(1.5)消失`);
    const absorbed = await waitFor(() => (firstComp()?.bufferInput[0].count ?? 0) >= 1, 15000);
    if (!absorbed) {
      console.log(`[${ts()}] T2.6 测试失败: 15 秒内物品未被吸入——仿真时钟未推进？页面在后台被深度节流时请切到前台再试`);
      return 'T2.6 测试失败: 物品未被吸入输入槽（仿真未推进？）';
    }
    // 预约即 +1，物品应正在走进设备（下一 Tick 起越过 0.5 继续前进，entering 标记）
    const walkingIn = await waitFor(() => (tailHeadItem()?.progress ?? 0) > 0.51, 3000);
    const walking = tailHeadItem();
    if (!walkingIn || !walking) {
      console.log(`[${ts()}] T2.6 测试失败: 预约后物品未走进设备（应越过 0.5 前进）:\n${beltStatus()}`);
      return 'T2.6 测试失败: 预约后物品未前进';
    }
    console.log(`[${ts()}] [步骤3] 物品在门口(0.5)预约进槽（输入槽已 +1），正走进设备（progress=${walking.progress.toFixed(2)} → 1.5 处消失）`);
    const vanished = await waitFor(() => tailHeadItem() === null, 8000); // 0.5→1.5 需 40 Tick(2 秒)
    if (!vanished) {
      console.log(`[${ts()}] T2.6 测试失败: 预约物品未在端口格中心消失（8 秒内）:\n${beltStatus()}`);
      return 'T2.6 测试失败: 物品未消失在端口格中心';
    }
    console.log(`[${ts()}] [步骤4] 物品到达端口格中心消失，已进入输入槽（上方 [T2.6 物流] 即吸入消息）:\n${inputBuffer()}`);

    console.log(`[${ts()}] [步骤5] 注满输入槽 50/50，再放一个源矿 → 物品应停在供给格中心（精炼炉门口）`);
    injectInput('originium_ore', 49);
    injectBeltItem('originium_ore');
    const stopped = await waitFor(() => {
      const head = tailHeadItem();
      return head !== null && head.progress >= 0.49;
    }, 15000);
    if (!stopped) {
      console.log(`[${ts()}] T2.6 测试失败: 物品未停在门口（被提前吸入或未到达）:\n${beltStatus()}`);
      return 'T2.6 测试失败: 满槽时物品未停在门口';
    }
    await sleep(700); // 停稳观察: progress 应保持 0.50 不动
    const parked = tailHeadItem();
    console.log(
      `[${ts()}] [步骤6] 物品停在精炼炉门口供给格中心（progress=${parked?.progress.toFixed(2)} 不再前进，输入槽满）:\n${beltStatus()}`,
    );
    console.log(`[${ts()}] [步骤7] consumeInput(1) 腾出空位（模拟生产消耗）→ 门口物品应立即被预约并走进设备`);
    consumeInput(1);
    const resumed = await waitFor(() => {
      const c = firstComp();
      return c !== null && (c.bufferInput[0].count ?? 0) >= 50 && (tailHeadItem() === null);
    }, 8000);
    if (!resumed) {
      console.log(`[${ts()}] T2.6 测试失败: 疏通后物品未被吸入:\n${beltStatus()}\n${inputBuffer()}`);
      return 'T2.6 测试失败: 疏通后物品未被吸入';
    }
    console.log(`[${ts()}] [步骤8] 疏通后门口物品被预约、走进设备并消失，输入槽回满:\n${inputBuffer()}`);
    console.log(`[${ts()}] ════ T2.6 一键测试完成 ════`);
    return 'T2.6 一键测试完成（关键输出见控制台 [T2.6 物流] / [步骤N] 日志）';
  };

  /** 输出槽首槽数量（outputBuffer 解析；无设备/空槽 → 0）。 */
  const outputCount = (handle?: EntityHandle): number => {
    const h = handle ?? firstBuildingHandle();
    if (h === null || !game.world.isAlive(h)) return 0;
    const slot = game.world.getComponent<BuildingComp>(h, 'BuildingComp')?.bufferOutput[0];
    return slot?.count ?? 0;
  };
  /** T2.7 一键测试主体（并发/重复保护见 runTest 的 phase 状态机）。
   * 场景A: 精炼炉(5,5) + 上行传送带×3 接顶中输出端口(6,5)，输出槽预注 晶体外壳 ×5 → 观察物品
   *        逐件出现在传送带起点、一格一件沿带前进（不依赖生产计时，时序确定）。
   *        带满 3 件（一格一件@0.5）后输出槽剩 2 件 → 停留观察 → 预告 5 秒后切场景。
   * 场景B: 1 格断头带 + 预注 5 件 → 带上 1 件@0.5 即满 → 其余 4 件留在输出槽 →
   *        consumeBeltTailItem 疏通 → 槽内物品继续上带。 */
  const demoT27 = async (): Promise<string> => {
    console.log(`[${ts()}] ════ T2.7 一键测试: 设备 → 传送带输出对接 ════`);
    // ── 场景A: 出货流动（一格一件）──
    clearAllPlaced();
    if (!placeAt('refining_unit', 5, 5)) return 'T2.7 测试失败: 精炼炉放置失败';
    const created = spawnBelt([[6, 4], [6, 3], [6, 2]], 270); // 首段 (6,4) 入口朝向顶中输出端口 (6,5)
    if (created !== 3) return 'T2.7 测试失败: 传送带创建失败';
    injectOutput('origocrust', 5);
    console.log(`[${ts()}] [步骤1] 场景就绪: 精炼炉(5,5) 顶中输出端口(6,5) + 上行传送带×3，输出槽预注 晶体外壳 ×5`);
    console.log(`[${ts()}] [步骤2] 观察画面: 物品逐件出现在传送带起点（紧邻端口一侧），一格一件沿带向上前进（每 ~2 秒一件）`);
    const firstOut = await waitFor(() => outputCount() < 5, 10000);
    if (!firstOut) {
      console.log(`[${ts()}] T2.7 测试失败: 10 秒内无物品上带——仿真时钟未推进？页面在后台被深度节流时请切到前台再试`);
      return 'T2.7 测试失败: 输出槽物品未上带（仿真未推进？）';
    }
    console.log(`[${ts()}] [步骤3] 首件已上带（上方 [T2.7 物流] 即输出消息）:\n${beltStatus()}`);
    console.log(`[${ts()}] [步骤4] 观察 8 秒: 物品逐件沿带前进，每格至多一件（物品所在格的箭头隐去）...`);
    await sleep(8000);
    // 等带满: 3 格各 1 件@0.5 → 输出槽停在 ×2
    const filled = await waitFor(() => outputCount() <= 2, 15000);
    if (!filled) {
      console.log(`[${ts()}] T2.7 测试失败: 15 秒内传送带未填满（应 3 格各 1 件、输出槽剩 2）:\n${beltStatus()}\n${outputBuffer()}`);
      return 'T2.7 测试失败: 传送带未按一格一件填满';
    }
    console.log(
      `[${ts()}] [步骤5] 带满: 3 格各 1 件（一格一物品，全部停在格中心 0.50），输出槽剩 ×${outputCount()}:\n${beltStatus()}\n${outputBuffer()}`,
    );
    console.log(`[${ts()}] [步骤6] 场景A观察完毕，5 秒后切换到满带演示场景（换成 1 格断头带）...`);
    await sleep(5000);

    // ── 场景B: 满带 → 物品留在输出槽 → 疏通恢复 ──
    clearAllPlaced();
    if (!placeAt('refining_unit', 5, 5)) return 'T2.7 测试失败: 场景B 精炼炉放置失败';
    if (spawnBelt([[6, 4]], 270) !== 1) return 'T2.7 测试失败: 场景B 传送带创建失败';
    injectOutput('origocrust', 5);
    console.log(`[${ts()}] [步骤7] 场景B: 1 格断头带 + 输出槽 5 件 → 带上 1 件即满（一格一物品），其余留在输出槽`);
    const jammed = await waitFor(() => outputCount() <= 4, 15000);
    if (!jammed) {
      console.log(`[${ts()}] T2.7 测试失败: 15 秒内未观察到满带堵停:\n${beltStatus()}\n${outputBuffer()}`);
      return 'T2.7 测试失败: 满带时物品未留在输出槽';
    }
    await sleep(1500); // 停稳观察: 输出槽应保持 4、带上 1 件不再变化
    const parked = outputCount();
    console.log(
      `[${ts()}] [步骤8] 满带: 带上 1 件@0.50，输出槽保持 晶体外壳 ×${parked} 不再减少:\n${beltStatus()}\n${outputBuffer()}`,
    );
    if (parked !== 4) {
      console.log(`[${ts()}] T2.7 测试失败: 停稳后输出槽应保持 ×4（实际 ×${parked}）`);
      return 'T2.7 测试失败: 满带堵停数量异常';
    }
    console.log(`[${ts()}] [步骤9] consumeBeltTailItem() 疏通（模拟下游取走）→ 输出槽物品继续上带`);
    consumeBeltTailItem();
    const resumed = await waitFor(() => outputCount() <= 3, 10000);
    if (!resumed) {
      console.log(`[${ts()}] T2.7 测试失败: 疏通后物品未继续上带:\n${beltStatus()}\n${outputBuffer()}`);
      return 'T2.7 测试失败: 疏通后未恢复出货';
    }
    console.log(`[${ts()}] [步骤10] 疏通恢复: 输出槽 ×${outputCount()}（物品重新上带）:\n${beltStatus()}`);
    console.log(`[${ts()}] ════ T2.7 一键测试完成 ════`);
    return 'T2.7 一键测试完成（关键输出见控制台 [T2.7 物流] / [步骤N] 日志）';
  };

  /** 指定类型端口当前是否有堵塞（portStatuses 同源判定，T2.8 一键测试用）。 */
  const portBlockedNow = (kind: 'input' | 'output'): boolean => {
    const h = firstBuildingHandle();
    if (h === null) return false;
    const comp = game.world.getComponent<BuildingComp>(h, 'BuildingComp');
    if (!comp) return false;
    const def = getBuildingDefinition(comp.definitionId);
    if (!def) return false;
    const st = portStatuses(game.world, h, comp, def);
    return (kind === 'input' ? st.input : st.output).some((p) => p.blocked);
  };
  /** T2.8 一键测试主体（并发/重复保护见 runTest 的 phase 状态机）。
   * 场景: 精炼炉(5,5) + 下行输入带×3（→底中输入口 6,7）+ 上行输出带×3（顶中输出口 6,5→）。
   * 演示序列（每步观察节奏对齐 t27 经验）:
   *   working(原LOGO) → paused(深灰图标·计时冻结) → 恢复 → blocked(红X·双端口红)
   *   → 疏通(LOGO复原·端口回黄) → 输入满槽堵停(输入口红) → 疏通回黄。
   * 时序确定性: blocked 期间结算暂缓不消耗输入槽（A8 §2.2）→ 输入堵停演示不受生产消耗竞争。 */
  const demoT28 = async (): Promise<string> => {
    console.log(`[${ts()}] ════ T2.8 一键测试: 设备状态机与终末地风格状态视觉 ════`);
    clearAllPlaced();
    if (!placeAt('refining_unit', 5, 5)) return 'T2.8 测试失败: 精炼炉放置失败';
    if (spawnBelt([[6, 10], [6, 9], [6, 8]], 270) !== 3) return 'T2.8 测试失败: 输入传送带创建失败';
    if (spawnBelt([[6, 4], [6, 3], [6, 2]], 270) !== 3) return 'T2.8 测试失败: 输出传送带创建失败';
    injectInput('originium_ore', 10);
    injectBeltItem('originium_ore');
    console.log(`[${ts()}] [步骤1] 场景就绪: 精炼炉(5,5) + 下行输入带×3(→底中输入口 6,7) + 上行输出带×3(顶中输出口 6,5→)，源矿已上带`);
    const working = await waitFor(() => firstComp()?.state === 'working', 8000);
    if (!working) {
      console.log(`[${ts()}] T2.8 测试失败: 设备未进入 working——仿真时钟未推进（页面在后台被深度节流？切到前台再试）`);
      return 'T2.8 测试失败: 设备未进入 working';
    }
    console.log(
      `[${ts()}] [步骤2] 生产中(working): 顶层 LOGO 保持原样。观察画面: 输入/输出端口格黄色高亮(已连接)，` +
      `源矿流进设备、晶体外壳流上输出带。端口状态:\n${portStatus()}`,
    );
    await sleep(4000);

    // ── 暂停演示: LOGO 深灰 + 计时冻结 ──
    console.log(`[${ts()}] [步骤3] setPaused(true) → 顶层 LOGO 变深灰暂停图标（两竖条）`);
    setPaused(true);
    const frozenP = firstComp()?.progress ?? 0;
    await sleep(1500);
    if ((firstComp()?.progress ?? 0) !== frozenP) {
      console.log(`[${ts()}] T2.8 测试失败: 暂停期间计时仍在推进`);
      return 'T2.8 测试失败: 暂停期间计时仍在推进';
    }
    console.log(`[${ts()}] [步骤4] 暂停生效: 进度冻结在 ${(frozenP * 100).toFixed(1)}%（1.5 秒采样不变），不吸入不输出（物流视同离线）:\n${productionStatus()}`);
    await sleep(2500); // 观察深灰图标
    console.log(`[${ts()}] [步骤5] setPaused(false) → LOGO 复原，从暂停处继续`);
    setPaused(false);
    const resumedOk = await waitFor(() => firstComp()?.state === 'working', 6000);
    if (!resumedOk) {
      console.log(`[${ts()}] T2.8 测试失败: 恢复后未继续生产:\n${productionStatus()}`);
      return 'T2.8 测试失败: 恢复后未继续生产';
    }
    console.log(`[${ts()}] [步骤6] 恢复生产(working)，计时从暂停处继续（进度大于冻结值 ${(frozenP * 100).toFixed(1)}%）:\n${productionStatus()}`);
    await sleep(1500);

    // ── blocked 演示: LOGO 红 X + 双端口红 ──
    console.log(`[${ts()}] [步骤7] 注满输出槽(×50) → 下次结算暂缓 → 顶层 LOGO 变红 X（blocked）`);
    injectOutput('origocrust', 50);
    const blocked = await waitFor(() => firstComp()?.state === 'blocked', 8000);
    if (!blocked) {
      console.log(`[${ts()}] T2.8 测试失败: 8 秒内未进入 blocked:\n${productionStatus()}`);
      return 'T2.8 测试失败: 未进入 blocked';
    }
    console.log(`[${ts()}] [步骤8] blocked: 结算暂缓、原料未扣（上方 [T2.5 生产] blocked 消息），LOGO 红 X。`);
    console.log(`[${ts()}] [步骤9] 注满输入槽(×50) + 再放一个源矿 → 物品停在门口 → 输入端口格变红；输出带被产物填满 → 输出端口格变红（观察约 8 秒，两处红 + 红 X LOGO）`);
    injectInput('originium_ore', 50);
    injectBeltItem('originium_ore');
    const bothJam = await waitFor(
      () => portBlockedNow('input') && portBlockedNow('output'), 20000,
    );
    if (!bothJam) {
      console.log(`[${ts()}] T2.8 测试失败: 20 秒内未观察到双端口堵塞:\n${portStatus()}\n${beltStatus()}`);
      return 'T2.8 测试失败: 双端口堵塞未出现';
    }
    console.log(`[${ts()}] [步骤10] 双端口红（输入=物品停门口 / 输出=满带留槽）:\n${portStatus()}`);
    await sleep(4000); // 停稳观察

    // ── 疏通: LOGO 复原 + 端口回黄 ──
    console.log(`[${ts()}] [步骤11] consumeOutput(50) 疏通输出 → blocked 解除（LOGO 复原）；生产恢复消耗输入 → 门口物品进门（输入端口回黄）`);
    consumeOutput(50);
    const unblocked = await waitFor(() => firstComp()?.state !== 'blocked', 6000);
    const inputClear = await waitFor(() => !portBlockedNow('input'), 8000);
    if (!unblocked || !inputClear) {
      console.log(`[${ts()}] T2.8 测试失败: 疏通后未恢复:\n${productionStatus()}\n${portStatus()}`);
      return 'T2.8 测试失败: 疏通后未恢复';
    }
    console.log(`[${ts()}] [步骤12] 疏通完成: LOGO 复原、输入端口回黄（门口物品已进门）。输出端口如仍红属正常——断头带容量有限，产物满带留槽:\n${portStatus()}`);
    console.log(`[${ts()}] ════ T2.8 一键测试完成 ════`);
    return 'T2.8 一键测试完成（关键输出见控制台 [T2.8] / [步骤N] 日志，画面: LOGO 状态图标 + 端口黄/红高亮）';
  };

  /**
   * 一键测试入口（含重复调用保护）。可用: 't25'（生产计时与生产循环）、't26'（传送带→设备输入对接）。
   *
   * phase 状态机（用户实测：内置浏览器控制台会在执行后**自动重发**上一条命令，
   * 每秒 2~4 次、每轮结束立即再触发，导致测试无限循环重跑）:
   *   idle     → 首次调用运行测试
   *   running  → 重复调用忽略（第 2 次打印一次来源栈后静默）
   *   done     → 成功后本次页面加载不再重跑（重跑=刷新页面），重复调用只提示一次
   *   cooldown → 失败后 30 秒冷却，避免自动重发导致失败循环重试
   * 每个测试名独立一套 phase（互不影响，t25 跑完仍可跑 t26）。
   */
  type TestPhase = 'idle' | 'running' | 'done' | 'cooldown';
  const testPhases = new Map<string, { phase: TestPhase; until: number; ignores: number }>();
  const phaseOf = (name: string) => {
    let p = testPhases.get(name);
    if (!p) { p = { phase: 'idle', until: 0, ignores: 0 }; testPhases.set(name, p); }
    return p;
  };
  const testIgnore = (name: string, hint: string): string => {
    const p = phaseOf(name);
    p.ignores++;
    if (p.ignores === 2) {
      // 打印一次调用来源栈，确诊自动重发的来源（控制台手输 = 短栈 at <anonymous>:1:x）
      const stack = new Error().stack?.split('\n').slice(2, 6).join('\n') ?? '(无栈)';
      console.log(
        `[${ts()}] [${name}] 检测到命令被自动重发，已忽略 ${p.ignores} 次（后续静默忽略）。${hint}\n` +
        `  调用来源（诊断用）:\n${stack}`,
      );
    }
    return `已忽略（${hint}）`;
  };
  /** T2.12 一键测试主体（并发/重复保护见 runTest 的 phase 状态机）。
   * 场景: 仓库取货口(5,5) + 上行带×4 (6,4)→(6,1) + 仓库存货口(5,0)——第一条
   * 完整物流链（无限源 → 传送带 → 无限汇，无生产环节，玩家肉眼全程可读）。
   * 演示: 源矿源源不断上带 → 流动 4 格 → 走进存货口消失 → 暂停取货口停供 → 恢复续供。 */
  const demoT212 = async (): Promise<string> => {
    console.log(`[${ts()}] ════ T2.12 一键测试: 仓库取货口 → 传送带 → 仓库存货口 ════`);
    clearAllPlaced();
    if (!placeAt('depot_unloader', 5, 5)) return 'T2.12 测试失败: 取货口放置失败';
    if (!placeAt('depot_loader', 5, 0)) return 'T2.12 测试失败: 存货口放置失败';
    if (spawnBelt([[6, 4], [6, 3], [6, 2], [6, 1]], 270) !== 4) return 'T2.12 测试失败: 传送带创建失败';
    const depotCount = (type: string): number =>
      machineSystem.recentEvents.filter((e) => e.type === type).length;
    const outBase = depotCount('depot-output');
    const inBase = depotCount('depot-input');
    console.log(
      `[${ts()}] [步骤1] 场景就绪: 取货口(5,5) + 上行带×4 + 存货口(5,0)。` +
      `观察画面: 源矿从取货口上方源源出现（1件/2秒）、沿带上升、走进存货口消失`,
    );
    const outOk = await waitFor(() => depotCount('depot-output') - outBase >= 3, 15000);
    if (!outOk) {
      console.log(`[${ts()}] T2.12 测试失败: 取货口未输出——仿真时钟未推进（页面在后台被深度节流？切到前台再试）`);
      return 'T2.12 测试失败: 取货口未输出';
    }
    console.log(`[${ts()}] [步骤2] 无限源工作: 取货口已输出 ${depotCount('depot-output') - outBase} 件源矿（beltStatus() 可查带上位置）`);
    const inOk = await waitFor(() => depotCount('depot-input') - inBase >= 3, 15000);
    if (!inOk) return 'T2.12 测试失败: 存货口未接收';
    console.log(`[${ts()}] [步骤3] 无限汇工作: 存货口已接收 ${depotCount('depot-input') - inBase} 件（物品走到端口格中心消失，永不堵塞）`);
    // 暂停演示: setPaused 缺省操作第一台设备 = 取货口（先放置）
    setPaused(true);
    const before = depotCount('depot-output');
    await sleep(4000);
    const stopped = depotCount('depot-output') === before;
    setPaused(false);
    if (!stopped) return 'T2.12 测试失败: 暂停期间取货口仍在输出';
    console.log(`[${ts()}] [步骤4] 暂停语义: 取货口 paused 4 秒零输出（对齐 T2.8 生产设备暂停: 视同离线），已恢复`);
    const resumed = await waitFor(() => depotCount('depot-output') >= before + 2, 10000);
    if (!resumed) return 'T2.12 测试失败: 恢复后取货口未续供';
    console.log(`[${ts()}] [步骤5] 恢复续供: 新输出 ${depotCount('depot-output') - before} 件。提示: 点击两个仓库口 → T2.9 读数不显示任何数据（非生产设备，无缓冲区）`);
    return 'T2.12 一键测试完成（关键观察: 源矿持续上带 → 流动 → 进存货口消失；暂停停供/恢复续供）';
  };

  /** 按格坐标精确定位传送带段（demoT210 用: injectBeltItem 只认 segmentIndex===0 的
   *  第一条链，多条独立单格链无法定向——按 Position 匹配目标格）。 */
  const beltAtCell = (gx: number, gy: number): BeltSegmentComp | null => {
    for (const h of game.world.query('BeltSegmentComp')) {
      const pos = game.world.getComponent<Position>(h, 'Position');
      if (!pos) continue;
      if (Math.round(pos.x / CELL_SIZE) === gx && Math.round(pos.y / CELL_SIZE) === gy) {
        return game.world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp') ?? null;
      }
    }
    return null;
  };
  /** 移除指定格传送带段上的队首物品（demoT210 定向疏通用，consumeBeltTailItem 是全链扫射）。 */
  const takeBeltItemAtCell = (gx: number, gy: number): boolean => {
    const seg = beltAtCell(gx, gy);
    if (!seg || seg.items.length === 0) return false;
    seg.items.sort((a, b) => b.progress - a.progress);
    seg.items.shift();
    return true;
  };
  /** T2.10 一键测试主体（并发/重复保护见 runTest 的 phase 状态机）。
   * 场景A（输入轮询）: 精炼炉三侧各一条供给带，晶体外壳作原料（无配方匹配 → 设备
   *   恒 idle 零结算干扰）。满槽每次 consumeInput 腾 1 位 → 观察补货顺序
   *   左→中→右 轮转（事件 portIndex 序 [0,1,2]×2）。
   * 场景B（输出轮转·可见版）: 预注源矿连续生产（1件/2秒），三个输出口各接 3 格
   *   传送带汇入顶部存货口 → 产物每 2 秒出现在下一条带首（输出口1→2→3 循环），
   *   沿带流动 3 格消失——轮询次序肉眼可辨。
   * 场景C（堵塞跳过+恢复·可见版）: 中带截短 2 格断头并预置满（永久堵塞）→ 产物
   *   只在左/右带交替出现；等左右带首腾空后注 3 件 → 左→右→中（恢复探测追加队尾）。 */
  const demoT210 = async (): Promise<string> => {
    console.log(`[${ts()}] ════ T2.10 一键测试: 端口轮询系统 ════`);
    const inputPortsOf = (): number[] =>
      machineSystem.recentEvents.filter((e) => e.type === 'input').map((e) => e.portIndex ?? -1);
    const outputPortsOf = (): number[] =>
      machineSystem.recentEvents.filter((e) => e.type === 'output').map((e) => e.portIndex ?? -1);

    // ── 场景A: 输入轮询（左→中→右）──
    clearAllPlaced();
    if (!placeAt('refining_unit', 5, 5)) return 'T2.10 测试失败: 精炼炉放置失败';
    const SUPPLY: Array<[number, number]> = [[5, 8], [6, 8], [7, 8]]; // 左/中/右输入口的供给格
    for (const [x, y] of SUPPLY) {
      if (spawnBelt([[x, y]], 270) !== 1) return 'T2.10 测试失败: 供给带创建失败';
    }
    // 关键: 用晶体外壳作原料——精炼炉没有以它为原料的配方 → 设备恒 idle、零结算，
    // 输入槽只被本测试的 consumeInput 腾位（若用源矿，生产每 2 秒结算一次会插入额外补货）
    injectInput('origocrust', 50); // 满槽锁定: 每次腾 1 位 → 补货顺序肉眼可辨
    console.log(`[${ts()}] [步骤1] 场景A就绪: 精炼炉(5,5) + 左/中/右三条供给带（晶体外壳作原料，无配方匹配 → 无生产干扰）。` +
      `输入槽满载，每次腾出 1 个空位，观察哪个输入口被轮到`);
    const seqIn: number[] = [];
    for (let i = 0; i < 6; i++) {
      // 等全部供给格门口复位（上一轮的预约物品已走进设备消失，无 entering 残留）——
      // 条件等待而非固定 sleep，免疫真实仿真的节奏抖动
      const doorsSettled = await waitFor(() => SUPPLY.every(([x, y]) => {
        const seg = beltAtCell(x, y);
        return !seg || seg.items.every((it) => !it.entering);
      }), 8000);
      if (!doorsSettled) {
        console.log(`[${ts()}] T2.10 测试失败: 8 秒内门口物品未完成进设备（仿真未推进？切前台重试）`);
        return 'T2.10 测试失败: 门口物品未复位';
      }
      // 门口为空的供给格补一件晶体外壳
      for (const [x, y] of SUPPLY) {
        const seg = beltAtCell(x, y);
        if (seg && seg.items.length === 0) {
          seg.items.push({ itemId: 'origocrust', progress: BeltSystem.beltPhase, delta: 0 });
        }
      }
      const before = inputPortsOf().length;
      consumeInput(1); // 模拟一次结算扣料: 满→49（恰好 1 个空位）
      await waitFor(() => inputPortsOf().length - before >= 1, 5000); // 等本次吸入落地
      const evs = inputPortsOf().slice(before);
      seqIn.push(...evs);
      console.log(
        `[${ts()}] [步骤2-${i + 1}/6] 腾出 1 位 → 本次补货端口: ` +
        (evs.length === 1 ? `输入口${evs[0] + 1}` : `(异常 ${JSON.stringify(evs)})`) +
        `　累计序列: ${seqIn.map((p) => p + 1).join('→') || '(空)'}`,
      );
    }
    if (JSON.stringify(seqIn) !== JSON.stringify([0, 1, 2, 0, 1, 2])) {
      console.log(`[${ts()}] T2.10 测试失败: 输入补货序列应为 左→中→右×2（实际 ${JSON.stringify(seqIn)}）:\n${portStatus()}`);
      return 'T2.10 测试失败: 输入轮询顺序异常';
    }
    console.log(`[${ts()}] [步骤3] ✅ 输入轮询验证通过: 补货顺序 左→中→右→左→中→右（指针满载冻结、轮转不重置）`);

    // ── 场景B: 输出轮转（连续生产·可见版）──
    // 预注源矿让设备 1 件/2 秒稳定产出 → 每次只有 1 件产物待出货 → 轮询严格逐件
    // 轮转: 晶体外壳每 2 秒出现在**下一条**带首（输出口1→2→3 循环），沿 3 格带
    // 流动走进顶部存货口。三条带对称全空时同 Tick 多口齐出的"爆发"在这里不会
    // 发生——轮询次序因此肉眼可辨（用户 2026-08-25 反馈: 1 格断头带场景两端口
    // 同 Tick 齐出，看不出轮询；节流是每端口每 Tick 1 件，不是每设备 1 件）。
    console.log(`[${ts()}] [步骤4] 切换场景B: 预注源矿连续生产（1件/2秒），三个输出口各接 3 格传送带汇入顶部存货口 → 观察产物轮流出现在左/中/右带首`);
    clearAllPlaced();
    if (!placeAt('refining_unit', 5, 5)) return 'T2.10 测试失败: 场景B 精炼炉放置失败';
    injectInput('originium_ore', 30); // 连续生产 ≈60 秒产物供给（1件/2秒）
    if (!placeAt('depot_loader', 5, 1)) return 'T2.10 测试失败: 场景B 存货口放置失败';
    for (const x of [5, 6, 7]) {
      if (spawnBelt([[x, 4], [x, 3], [x, 2]], 270) !== 3) return 'T2.10 测试失败: 场景B 3 格接收带创建失败';
    }
    const rotBase = outputPortsOf().length;
    const sixOut = await waitFor(() => outputPortsOf().length - rotBase >= 6, 30000);
    if (!sixOut) {
      console.log(`[${ts()}] T2.10 测试失败: 30 秒内不足 6 件出货（仿真未推进？切前台重试）:\n${portStatus()}`);
      return 'T2.10 测试失败: 连续生产未出货';
    }
    const rotSeq = outputPortsOf().slice(rotBase, rotBase + 6);
    console.log(`[${ts()}] [步骤5] 前 6 件出货端口: 输出口${rotSeq.map((p) => p + 1).join('→')}${rotSeq.length > 6 ? `（后续继续轮转: ${outputPortsOf().slice(rotBase + 6).map((p) => p + 1).join('→')}）` : ''}`);
    if (JSON.stringify(rotSeq) !== JSON.stringify([0, 1, 2, 0, 1, 2])) {
      console.log(`[${ts()}] T2.10 测试失败: 连续生产下出货应为 1→2→3 循环（实际 ${JSON.stringify(rotSeq)}）:\n${portStatus()}`);
      return 'T2.10 测试失败: 输出轮询顺序异常';
    }
    console.log(`[${ts()}] [步骤5b] ✅ 输出轮转验证通过。观察画面 8 秒: 晶体外壳轮流出现在三条带首、沿 3 格带上升、走进存货口消失...`);
    await sleep(8000);

    // ── 场景C: 堵塞跳过 + 恢复追加队尾（可见版）──
    // 中带截短为 2 格断头带并预置满（永久堵塞）→ 产物只在左/右带交替出现；
    // 等左右带首都腾空后一次性注 3 件货 → 依次 左→右→（恢复探测）中，中口排在
    // 最后 = "恢复追加到当前轮询顺序末尾"的可见形态。
    console.log(`[${ts()}] [步骤6] 切换场景C: 左/右 3 格带接存货口，中带截短为 2 格断头带并预置满（永久堵塞）→ 产物应只在左右带交替出现`);
    clearAllPlaced();
    if (!placeAt('refining_unit', 5, 5)) return 'T2.10 测试失败: 场景C 精炼炉放置失败';
    injectInput('originium_ore', 30);
    if (!placeAt('depot_loader', 5, 1)) return 'T2.10 测试失败: 场景C 存货口放置失败';
    if (spawnBelt([[5, 4], [5, 3], [5, 2]], 270) !== 3) return 'T2.10 测试失败: 场景C 左带创建失败';
    if (spawnBelt([[6, 4], [6, 3]], 270) !== 2) return 'T2.10 测试失败: 场景C 中带创建失败';
    if (spawnBelt([[7, 4], [7, 3], [7, 2]], 270) !== 3) return 'T2.10 测试失败: 场景C 右带创建失败';
    beltAtCell(6, 4)?.items.push({ itemId: 'origocrust', progress: 0.5, delta: 0 }); // 中带预置满（2 格断头）
    beltAtCell(6, 3)?.items.push({ itemId: 'origocrust', progress: 0.5, delta: 0 });
    const skipBase = outputPortsOf().length;
    const fourOut = await waitFor(() => outputPortsOf().length - skipBase >= 4, 30000);
    if (!fourOut) {
      console.log(`[${ts()}] T2.10 测试失败: 30 秒内不足 4 件出货:\n${portStatus()}`);
      return 'T2.10 测试失败: 场景C 未出货';
    }
    const skipSeq = outputPortsOf().slice(skipBase, skipBase + 4);
    console.log(`[${ts()}] [步骤7] 堵塞期出货端口: 输出口${skipSeq.map((p) => p + 1).join('→')}（中口被跳过，画面: 中带红堵、左右带轮流流动）`);
    if (!skipSeq.every((p) => p === 0 || p === 2)) {
      console.log(`[${ts()}] T2.10 测试失败: 中口堵塞时产物不应出现在中带（实际 ${JSON.stringify(skipSeq)}）`);
      return 'T2.10 测试失败: 堵塞端口未被跳过';
    }
    // 等左右带首都腾空（在途物品已推进到带深处）→ 一次性注 3 件 → 左→右→中
    console.log(`[${ts()}] [步骤8] 等左右带首腾空后注 3 件产物 → 预期出货 左→右→中（中口恢复探测追加队尾）`);
    const headsFree = await waitFor(() => {
      const l = beltAtCell(5, 4);
      const r = beltAtCell(7, 4);
      return (l?.items.length ?? 0) === 0 && (r?.items.length ?? 0) === 0;
    }, 20000);
    if (!headsFree) {
      console.log(`[${ts()}] T2.10 测试失败: 20 秒内左右带首未同时腾空:\n${beltStatus()}`);
      return 'T2.10 测试失败: 左右带首未腾空';
    }
    takeBeltItemAtCell(6, 4); // 清空 2 格断头中带 → 中口恢复
    takeBeltItemAtCell(6, 3);
    injectOutput('origocrust', 3);
    const recBase = outputPortsOf().length;
    const threeOut = await waitFor(() => outputPortsOf().length - recBase >= 3, 30000);
    if (!threeOut) {
      console.log(`[${ts()}] T2.10 测试失败: 30 秒内不足 3 件恢复出货:\n${portStatus()}`);
      return 'T2.10 测试失败: 恢复出货未发生';
    }
    const recSeq = outputPortsOf().slice(recBase, recBase + 3);
    console.log(`[${ts()}] [步骤9] 恢复后出货端口: 输出口${recSeq.map((p) => p + 1).join('→')}`);
    if (JSON.stringify(recSeq) !== JSON.stringify([0, 2, 1])) {
      console.log(`[${ts()}] T2.10 测试失败: 恢复后应 左→右→中（中口追加队尾，不插队；实际 ${JSON.stringify(recSeq)}）:\n${portStatus()}`);
      return 'T2.10 测试失败: 恢复端口未追加队尾';
    }
    console.log(`[${ts()}] [步骤10] ✅ 堵塞跳过 + 恢复追加队尾验证通过。最终轮询状态:\n${portStatus()}`);
    console.log(`[${ts()}] ════ T2.10 一键测试完成 ════`);
    return 'T2.10 一键测试完成（场景A 补货 1→2→3×2；场景B 出货 1→2→3 循环；场景C 跳过中带 + 恢复 左→右→中）';
  };

  const TESTS: Record<string, () => Promise<string>> = {
    t25: demoT25, t26: demoT26, t27: demoT27, t28: demoT28, t212: demoT212,
    t210: demoT210,
  };
  const runTest = async (name: string): Promise<string> => {
    const demo = TESTS[name];
    if (!demo) return `未知测试 '${name}'（可用: ${Object.keys(TESTS).join(', ')}）`;
    const p = phaseOf(name);
    if (p.phase === 'running') {
      return testIgnore(name, '测试正在进行中');
    }
    if (p.phase === 'done') {
      return testIgnore(name, '本次页面加载已完成过测试；想再跑一次请刷新页面 (F5) 后重新输入');
    }
    if (p.phase === 'cooldown' && performance.now() < p.until) {
      return testIgnore(name, '上次测试失败，30 秒冷却中（避免自动重发导致失败重试循环）');
    }
    p.phase = 'running';
    p.ignores = 0;
    let result: string;
    try {
      result = await demo();
    } catch (err) {
      console.error(`[${ts()}] [${name}] 一键测试异常:`, err);
      result = `${name.toUpperCase()} 测试失败: 异常`;
    }
    if (result.includes('一键测试完成')) {
      p.phase = 'done';
    } else {
      p.phase = 'cooldown';
      p.until = performance.now() + 30_000;
    }
    return result;
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
    belt,
    getTexture,
    spawnTestDevices,
    clearTestDevices,
    placeAt,
    getOccupiedCells,
    clearAllPlaced,
    selectFirstBuilding,
    deleteSelectedBuilding,
    selectFirstBelt,
    deleteSelectedBelt,
    perf,
    getMemoryStats: () => perf.sampleMemory(),
    spawnBenchmarkDevices,
    fillBenchmarkDevices,
    runFpsBenchmark,
    memoryStressCheck,
    spawnBelt,
    spawnBeltWithItem,
    consumeBeltTailItem,
    injectBeltItem,
    beltStatus,
    itemTable,
    recipeTable,
    recipeIndex,
    listRecipes,
    injectInput,
    consumeInput,
    inputBuffer,
    productionStatus,
    outputBuffer,
    injectOutput,
    consumeOutput,
    productionLog,
    setPaused, // T2.8: 玩家手动暂停（正式入口 T2.15 电源开关）
    portStatus, // T2.8: 端口连接/堵塞状态（渲染高亮同源判定）
    test: runTest,
  };

  console.log('[集成工业系统] T1.7 设备放置 + T1.8 基础交互 + T1.9 设备删除 + T1.10 性能基准 + T2.0 传送带创建就绪');
  console.log(`  世界: ${MAP.widthCells}×${MAP.heightCells} cells (MapInstance), CELL_SIZE=${CELL_SIZE}`);
  console.log('  操作: 中键拖拽/WASD(屏幕相对)/边缘滚动 平移, 滚轮以鼠标为中心缩放, Ctrl+R 视图旋转');
  console.log('  放置: 底部工具栏选设备 → 左键放网格 → R 旋转(相对视图) → 右键/ESC 取消');
  console.log('  传送带: E 进入创建模式 → 点蓝色高亮端口/末端选起点 → 移动鼠标显蓝色预览(L形+BFS绕障) → 左键加中继锚点延伸折线 → 右键/ESC/E 落盘整条链');
  console.log('  交互: 左键点设备=选中(黄色填充+白色选中框); 左键点传送带段=选中该格(白边+斜杠+隐pointer), 双击同段=选中整条链; 点空白=取消; Delete=删当前所选(单格→单段/整链→整链)');
  console.log('  验收: __game.placeAt("refining_unit",5,5) 放设备 → selectFirstBuilding() 选中 → deleteSelectedBuilding() 删除 → getOccupiedCells() 查占用');
  console.log('  T1.10: __game.spawnBenchmarkDevices(100) 一键100设备 / fillBenchmarkDevices() 铺满地图 → runFpsBenchmark() 采样FPS/内存 → memoryStressCheck() 内存压测');
  console.log('  T2.0: __game.spawnBelt([[5,5],[8,5],[8,8]],0) 程序化生成带转角传送带链 → 验证4方向转角+pointer流动');
  console.log('  T2.0 链管理: spawnBelt后 selectFirstBelt() 单击选单格 / selectFirstBelt(true) 双击选整链 → deleteSelectedBelt() 删当前所选');
  console.log('  T2.1/T2.2: __game.spawnBeltWithItem([[10,10],[11,10],[12,10],[13,10]],0,"cuprium_ore") 多格直链物品流动; 转角测试 [[10,12],[10,10],[12,10]],270 L形链物品转弯(动画同pointer); consumeBeltTailItem() 测堵塞疏通');
  console.log('  T2.3: __game.listRecipes("refining_unit") 配方查询 → "精炼炉配方：晶体外壳(源矿×1, 2秒)、蓝铁块(蓝铁矿×1, 2秒)、..."');
  console.log('  T2.4: __game.placeAt("refining_unit",5,5) → injectInput("originium_ore",3) → "输入槽0: 源矿 × 3/50 (已锁定)" → consumeInput(3) 扣空解锁; inputBuffer() 查看当前槽');
  console.log('  T2.5 一键测试: __game.test("t25")  ← 复制这一条到控制台回车即可（自动放设备+注料+计时+结算+blocked疏通演示）');
  console.log('  T2.5 手动: placeAt("refining_unit",5,5) → injectInput("originium_ore",3) → productionStatus() 监控计时(期间输入槽数量不变) → 结算 "输入槽 源矿 -1，输出槽 晶体外壳 +1" 并自动续启; injectOutput("origocrust",50)+等完成=blocked → consumeOutput(1) 疏通结算; productionLog() 查事件');
  console.log('  T2.6 一键测试: __game.test("t26")  ← 复制这一条到控制台回车即可（自动放炉+铺带+物品上门消失+满槽堵停+疏通吸入演示）');
  console.log('  T2.6 手动: placeAt("refining_unit",5,5) → spawnBelt([[6,9],[6,8]],270) 带尾指向底中输入端口 → injectBeltItem("originium_ore") → 物品到门口消失、inputBuffer() +1; injectInput(...,49) 注满 → 物品停在门口(beltStatus() 查 @0.50) → consumeInput(1) 疏通吸入');
  console.log('  T2.7 一键测试: __game.test("t27")  ← 复制这一条到控制台回车即可（放炉+输出端口铺带+产物一格一件上带流动+满带留槽+疏通恢复演示，场景切换有预告）');
  console.log('  T2.7 手动: placeAt("refining_unit",5,5) → spawnBelt([[6,4],[6,3]],270) 首段入口朝向顶中输出端口(6,5) → injectOutput("origocrust",5) → 物品逐件出现在带首、一格一件前进(productionStatus() 查输出槽递减); 1格断头带+5件 → 带上1件即满、输出槽留4件 → consumeBeltTailItem() 疏通继续出货');
  console.log('  T2.8 一键测试: __game.test("t28")  ← 复制这一条到控制台回车即可（LOGO 状态图标: 暂停深灰/堵塞红X + 端口黄/红高亮全流程演示）');
  console.log('  T2.8 手动: setPaused(true/false) 手动暂停/恢复（LOGO 换图标、计时冻结） → portStatus() 查端口连接黄/堵塞红（与画面高亮同源） → productionStatus() 对照 "(已暂停)" 标记');
  console.log('  T2.9 观察: 点击设备 → 屏幕左上显示"输入: x/50 输出: y/50"单行读数（临时件，T2.15 弹窗吸收）；点击仓库口不显示（非生产设备）');
  console.log('  T2.12 一键测试: __game.test("t212")  ← 复制这一条到控制台回车即可（取货口+4段带+存货口: 源矿持续上带→流动→进存货口消失+暂停/恢复演示）');
  console.log('  T2.12 手动: 工具栏选"仓库取货口"放置（R 只在水平两档旋转） → E 进创建模式悬停其上方（Status 面板蓝） → 从输出口起带上行 → 末端接"仓库存货口"底边 → 物品流进去消失');
  console.log('  T2.10 一键测试: __game.test("t210")  ← 复制这一条到控制台回车即可（3入补货 左→中→右×2；3出连续生产轮转 1→2→3（3格带流动动画）；中带堵塞跳过+恢复 左→右→中；约 1 分钟）');
  console.log('  T2.10 手动: portStatus() 查看"输入轮询指针/输出轮询队列"（与 productionLog() 的 输入口N/输出口N 序号对照）；多口接带时满槽腾位看补货顺序、堵一条带看出货跳过与疏通恢复');
}

main().catch((err) => {
  console.error('[集成工业系统] 初始化失败:', err);
});
