// 浏览器验收 — 删中段白闪（bug1）+ 断头链二次延长指针空洞（bug2）, 2026-09-09
//
// 复现用户原始场景:
//   A. 6 格带 (2,0)→(2,5) + 物品流到 (2,5) 停稳 → 删除 (2,4) → 下游 (2,5) 新链首格
//      不得闪白。逐帧像素判定（patch renderer.render, 帧内同步 toDataURL）,
//      并在暂停态删除（0-Tick 帧 = 风险上限路径）。
//   B. 承 A 的拆链 {2,5}（带停稳物品）→ 延长一次（+2,6）→ 二次延长（+2,7）→
//      每帧检查可见带内实体间距, 任何 >1.1 格空洞不得持续 >40 Tick（lockstep
//      永久洞 = bug; 追平期瞬态可接受）。堵塞（红）态同样在检查范围内。
//   C. 结构断言: 所有链遮罩 includeInBuild===false 且仅存在于有箭头的链上。
//
// 用法: 先 npm run dev, 然后 node scripts/verify-split-extend-browser.mjs
const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const OUT_DIR = 'gui-test-screenshots';

const { chromium } = await import(PW_URL);
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
const logs = [];
page.on('console', (m) => logs.push(m.text()));

await page.goto(BASE_URL);
await page.waitForFunction(() => window.__game && window.__game.spawnBeltWithItem, null, { timeout: 30000 });

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 安装逐帧捕获器（patch renderer.render; 帧内同步 toDataURL + 像素分析）──
await page.evaluate(() => {
  const g = window.__game;
  g.camera.zoom = 1.4;
  g.camera.x = 160;
  g.camera.y = 192;
  g.camera.update?.();
  const renderer = g.app.renderer;
  const orig = renderer.render.bind(renderer);
  const cap = {
    active: false, frames: [], canvas2d: null,
    rect: null, // {x,y,w,h} 屏幕坐标
  };
  g.__cap = cap;
  renderer.render = (...args) => {
    orig(...args);
    if (!cap.active) return;
    try {
      const url = g.app.canvas.toDataURL();
      const img = new Image();
      // 同步不可行 → 用 ImageBitmap + 独立解析: 直接存 url, 离屏后分析太重;
      // 这里用 createImageBitmap 是异步的 → 改为记录帧计数, 像素分析放到 capture.stop 后。
      cap.frames.push(url);
    } catch { cap.frames.push(null); }
  };
});

// 捕获停止后统一分析像素（避免逐帧 Image 解码挤占 rAF）。
// 判定: 矩形内 min(R,G,B) ≥ 248（纯白遮罩色）的**像素占比** > 25% = 该帧白闪。
const analyzeFrames = async (rect) => {
  const stats = await page.evaluate(async (rect) => {
    const cap = window.__game.__cap;
    const out = [];
    const c2 = document.createElement('canvas');
    c2.width = 1280; c2.height = 800;
    const ctx = c2.getContext('2d', { willReadFrequently: true });
    for (const url of cap.frames) {
      if (!url) { out.push(0); continue; }
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(Math.floor(rect.x), Math.floor(rect.y), Math.ceil(rect.w), Math.ceil(rect.h)).data;
      let white = 0, total = 0;
      for (let i = 0; i < d.length; i += 4) {
        total++;
        if (d[i] >= 248 && d[i + 1] >= 248 && d[i + 2] >= 248) white++;
      }
      out.push(white / total);
      bmp.close();
    }
    cap.frames = [];
    return out;
  }, rect);
  return stats;
};

console.log('═══ 场景 A: 删中段 → 下游新链首格白闪 ═══');

// A0. 清场 + 建 6 格带 + 物品
await page.evaluate(() => {
  const g = window.__game;
  g.clearAllPlaced();
  g.spawnBeltWithItem([[2, 0], [2, 1], [2, 2], [2, 3], [2, 4], [2, 5]], 270, 'cuprium_ore');
});
// 等物品流到 (2,5) 停稳（断头钳格心 0.5）
await page.waitForFunction(() => {
  const g = window.__game;
  const hs = g.world.query('BeltSegmentComp');
  for (const h of hs) {
    const seg = g.world.getComponent(h, 'BeltSegmentComp');
    const pos = g.world.getComponent(h, 'Position');
    if (seg.isTail && Math.abs(pos.y / 64 - 5) < 0.5 && (seg.items ?? []).some((it) => !it.entering && it.progress >= 0.5 && it.delta === 0)) return true;
  }
  return false;
}, null, { timeout: 20000 });
check('A0 物品已流到 (2,5) 停稳', true);

// A1. 运行态选中 (2,4) → 删除, 并**强制删除落在 0-Tick 帧**（lastBeltPhase=null ⇒
//     ticks=0: 新链运行时建队不播种, 复现真实玩家约 1/3 概率踩中的闪白窗口）
const a1 = await page.evaluate(() => {
  const g = window.__game;
  // 选中格 (2,4)
  const s = g.camera.worldToScreen(2 * 64 + 32, 4 * 64 + 32);
  const t0 = performance.now();
  g.selection.onPointerDown(s.x, s.y, 0, t0);
  g.selection.onPointerUp(t0 + 10);
  g.selection.update();
  const chain = g.selection.getSelectedChain();
  const selectedOk = chain && !chain.wholeChain && chain.handle !== null;
  // 强制连续两次 0-Tick update（复现真实闪白窗口）: Delete 键处理器里的同步
  // game.update() 时 beltPhase 未变 → ticks=0（不播种, 建**孤立白遮罩**）; 真实
  // 游戏里下一个 GameLoop 帧若恰好 0 仿真步（60fps/40tps 下 ~1/3 概率）→ 再次
  // ticks=0 → 本帧渲染孤立白遮罩 = 闪白一帧。这里强制 2 连 0-Tick 确定性复现。
  const pr = g.renderSystem.pointerRenderer;
  const origUpdate = pr.update.bind(pr);
  let force = 2;
  pr.update = (alpha, deltaMS) => {
    if (force > 0) {
      force--;
      pr.lastBeltPhase = null; // update() 内 ticks 判 0 → 队列不播种
    }
    return origUpdate(alpha, deltaMS);
  };
  // 开捕获 → 删除 → 捕获 1s 后关
  const cap = g.__cap;
  cap.active = true;
  cap.frames = [];
  const okDel = g.deleteSelectedBelt(); // game.update() 同步跑一帧（0-Tick）
  setTimeout(() => { cap.active = false; pr.update = origUpdate; }, 1000);
  return { selectedOk, okDel, chainInfo: chain ? { whole: chain.wholeChain } : null };
});
check('A1 (2,4) 单段选中并删除（0-Tick 帧复现窗口）', a1.selectedOk && a1.okDel, JSON.stringify(a1.chainInfo));
await page.waitForTimeout(1300);
// (2,5) 格屏幕矩形（删除后取, 相机没动; 外扩 24px 吸收 worldToScreen 与实际投影的偏差）
const rect = await page.evaluate(() => {
  const g = window.__game;
  const p0 = g.camera.worldToScreen(2 * 64, 5 * 64);
  const p1 = g.camera.worldToScreen(2 * 64 + 64, 5 * 64 + 64);
  const M = 24;
  return { x: p0.x - M, y: p0.y - M, w: p1.x - p0.x + 2 * M, h: p1.y - p0.y + 2 * M };
});
const fracs = await analyzeFrames(rect);
const whiteFrames = fracs.filter((f) => f > 0.25).length;
check('A2 删除 0-Tick 帧: (2,5) 无白闪（逐帧白色像素占比峰值 < 25%）', whiteFrames === 0, `帧数=${fracs.length} 白帧=${whiteFrames} 白色占比峰值=${Math.max(...fracs).toFixed(3)}`);
await page.screenshot({ path: `${OUT_DIR}/splitA-after-delete.png` });

// A3. 恢复 → 结构断言: 所有遮罩 includeInBuild=false 且链上有箭头
await page.evaluate(() => window.__game.setPaused(false));
await page.waitForTimeout(300);
const audit = await page.evaluate(() => {
  const pr = window.__game.renderSystem.pointerRenderer;
  const out = { masks: 0, badInclude: 0, badMeasurable: 0, orphan: 0, chains: 0 };
  for (const [cid, rt] of pr.chains) {
    out.chains++;
    if (!rt.mask) continue;
    out.masks++;
    if (rt.mask.includeInBuild !== false) out.badInclude++;
    if (rt.mask.measurable !== false) out.badMeasurable++;
    if (rt.queue.arrows.length === 0) out.orphan++;
  }
  return out;
});
check('A3 遮罩结构: 全部 includeInBuild=false 且无无箭头孤遮罩', audit.badInclude === 0 && audit.badMeasurable === 0 && audit.orphan === 0, JSON.stringify(audit));

console.log('═══ 场景 B: 断头链 {2,5} 两次延长 → 指针空洞 ═══');

// B1. 确认拆链 {2,5} 在且带停稳物品（承场景 A）
const b0 = await page.evaluate(() => {
  const g = window.__game;
  const hs = g.world.query('BeltSegmentComp');
  const segs = [];
  for (const h of hs) {
    const seg = g.world.getComponent(h, 'BeltSegmentComp');
    const pos = g.world.getComponent(h, 'Position');
    segs.push({ x: Math.round(pos.x / 64), y: Math.round(pos.y / 64), cid: seg.chainId, idx: seg.segmentIndex, tail: seg.isTail, items: (seg.items ?? []).length });
  }
  return segs;
});
const tailSeg = b0.find((s) => s.x === 2 && s.y === 5);
check('B0 拆链 {2,5} 存在且为独立链', !!tailSeg && tailSeg.items === 1, JSON.stringify(tailSeg));

// B2. 帧间距监视器: 每帧检查可见带内实体间距 >1.1 的空洞持续 Tick 数
await page.evaluate(() => {
  const g = window.__game;
  const mon = { runs: [], cur: 0, maxGap: 0, frames: 0 };
  g.__mon = mon;
  const pr = g.renderSystem.pointerRenderer;
  const tick = () => {
    mon.frames++;
    let worstGap = 0;
    for (const [, rt] of pr.chains) {
      // 物品身后最近实体间距（可见口径: 只排除几乎压在物品身上的箭头 <0.02）
      const items2 = [];
      for (const { seg } of rt.segs) {
        const idx = seg.segmentIndex ?? 0;
        for (const it of seg.items ?? []) if (!it.entering) items2.push(idx + it.progress);
      }
      for (const itotal of items2) {
        const behindArr = rt.queue.arrows.map((a) => a.pos).filter((p) => p < itotal - 0.02);
        const behind = behindArr.length ? Math.max(...behindArr) : -Infinity;
        if (behind > -Infinity && itotal - behind > worstGap) worstGap = itotal - behind;
      }
    }
    mon.maxGap = Math.max(mon.maxGap, worstGap);
    if (worstGap > 1.1) {
      mon.cur++;
      if (mon.cur > 40) mon.runs.push({ gap: worstGap, run: mon.cur });
    } else mon.cur = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// B3. 延长 1: +（2,6）
const ext1 = await page.evaluate(() => {
  const g = window.__game;
  const hs = g.world.query('BeltSegmentComp');
  let tail = null;
  for (const h of hs) {
    const seg = g.world.getComponent(h, 'BeltSegmentComp');
    const pos = g.world.getComponent(h, 'Position');
    if (seg.isTail && Math.round(pos.x / 64) === 2 && Math.round(pos.y / 64) === 5) tail = { h, seg };
  }
  if (!tail) return false;
  const cid = tail.seg.chainId;
  g.world.addComponent(tail.h, 'BeltSegmentComp', { ...tail.seg, isTail: false });
  const handle = g.world.createEntity();
  g.world.addComponent(handle, 'Position', { x: 2 * 64, y: 6 * 64 });
  g.world.addComponent(handle, 'SpriteComp', { group: 'devices', textureKey: 'transport_belt', width: 64, height: 64, layer: 2 });
  g.world.addComponent(handle, 'BeltSegmentComp', {
    chainId: cid, direction: 270, isCorner: false, entryDir: undefined, mirrorH: undefined,
    isTail: true, incomingDirection: undefined, segmentIndex: 1, phaseOffset: Math.random(), items: [], blocked: false,
  });
  g.occupancy.occupy(2, 6, 'transport_belt');
  g.game.update();
  return true;
});
check('B1 延长 +1 格（2,6, 同链接续）', ext1);
await page.waitForTimeout(1500);

// B4. 延长 2: +（2,7）
const ext2 = await page.evaluate(() => {
  const g = window.__game;
  const hs = g.world.query('BeltSegmentComp');
  let tail = null;
  for (const h of hs) {
    const seg = g.world.getComponent(h, 'BeltSegmentComp');
    const pos = g.world.getComponent(h, 'Position');
    if (seg.isTail && Math.round(pos.x / 64) === 2 && Math.round(pos.y / 64) === 6) tail = { h, seg };
  }
  if (!tail) return false;
  const cid = tail.seg.chainId;
  g.world.addComponent(tail.h, 'BeltSegmentComp', { ...tail.seg, isTail: false });
  const handle = g.world.createEntity();
  g.world.addComponent(handle, 'Position', { x: 2 * 64, y: 7 * 64 });
  g.world.addComponent(handle, 'SpriteComp', { group: 'devices', textureKey: 'transport_belt', width: 64, height: 64, layer: 2 });
  g.world.addComponent(handle, 'BeltSegmentComp', {
    chainId: cid, direction: 270, isCorner: false, entryDir: undefined, mirrorH: undefined,
    isTail: true, incomingDirection: undefined, segmentIndex: 2, phaseOffset: Math.random(), items: [], blocked: false,
  });
  g.occupancy.occupy(2, 7, 'transport_belt');
  g.game.update();
  return true;
});
check('B2 二次延长 +1 格（2,7）', ext2);

// B5. 观察 8 秒（含物品流到新断头停稳 + 堵塞红态）
await page.waitForTimeout(8000);
const b5 = await page.evaluate(() => {
  const mon = window.__game.__mon;
  window.__monStop = true;
  const segs = [];
  const g = window.__game;
  for (const h of g.world.query('BeltSegmentComp')) {
    const seg = g.world.getComponent(h, 'BeltSegmentComp');
    const pos = g.world.getComponent(h, 'Position');
    segs.push({ y: Math.round(pos.y / 64), items: (seg.items ?? []).length, blocked: seg.blocked === true });
  }
  return { frames: mon.frames, maxGap: +mon.maxGap.toFixed(3), overRuns: mon.runs.length, segs };
});
check('B3 二次延长后无持续空洞（>1.1 格且 >40 Tick）', b5.overRuns === 0, `帧=${b5.frames} 最大物品身后间距=${b5.maxGap} 段=${JSON.stringify(b5.segs)}`);
await page.screenshot({ path: `${OUT_DIR}/splitB-after-extend.png` });

// B6. 红色堵塞态再采样一张（物品已在 2,7 断头停稳, 整链 blocked）
const red = b5.segs.some((s) => s.blocked);
check('B4 断头链处于堵塞红态（红色覆盖下同样受检）', red, JSON.stringify(b5.segs));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项失败`}: ${results.length} 项检查`);
process.exit(failed.length === 0 ? 0 : 1);
