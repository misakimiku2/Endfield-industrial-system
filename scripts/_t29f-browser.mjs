// T2.29-f 浏览器视觉验证 — 用法: 先启动 dev server（npm run dev），然后:
//   node scripts/_t29f-browser.mjs
// 截图输出: log/t29f-grow-*.png / log/t29f-reg-*.png
//
// 方式1（场景图直读）: 从 __game.app.stage 深度查找 label='beltPointers' 容器
// （RenderSystem 注入 layer2Building zIndex 0.4），逐帧记录断头链（x≈416）上
// 每支箭头 sprite 的 (y, alpha, visible) 时间序列（rAF 采样 40s），同步低频记录
// 9 段链的物品快照（terminus 时间线）+ 堵塞生长窗口截图。
//
// 验收:
//   (a) 每支箭头消失前 alpha 单调递减 ≥3 个采样点（渐隐完成），无"上采样全亮
//       → 下采样直接消失"的硬切;
//   (b) 堵塞物品区（前沿之后 d > terminus+0.45）无可见箭头（alpha>0.05）;
//   (c) 堵塞前沿处持续有箭头渐入渐出（吞噬循环持续，渐隐事件遍布各前沿位置）;
//   (d) 对比修复前: 无"一支突然消失 + 一支走到停止位置"交替——每支都走到某个
//       停止位置（各自锁定的出场口）渐隐消失，渐隐位置随前沿后跳分布成阶梯。
// 快速回归: (a)两条异时创建空带流动且相位不同 (b)取货口带物品前无空格
//           (c)满载带物品下无箭头。

const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const OUT_DIR = 'log';
const CELL = 64;
const CHAIN_X = 6 * CELL + 32;   // 断头链世界 x（格 x=6）
const CHAIN_BOTTOM_Y = 10 * CELL; // 链首格 (6,9) 底缘（遮罩边界，带外等待区在此之下）
const SAMPLE_MS = 40000;          // 采样窗口

const { chromium } = await import(PW_URL);
import { mkdirSync, writeFileSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
};

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
const shot = (name) => page.screenshot({ path: `${OUT_DIR}/${name}.png` });

const focus = async (gx, gy, zoom = 0.6) => {
  await page.evaluate(({ gx, gy, zoom }) => {
    const g = window.__game;
    g.camera.setZoom(zoom);
    g.camera.x = (gx + 0.5) * 64;
    g.camera.y = (gy + 0.5) * 64;
  }, { gx, gy, zoom });
  await page.waitForTimeout(300);
};

/** 链上物品/堵塞状态诊断读数（按 chainId 分组）。 */
const beltState = () => page.evaluate(() => {
  const g = window.__game;
  const chains = {};
  for (const h of g.world.query('BeltSegmentComp')) {
    const seg = g.world.getComponent(h, 'BeltSegmentComp');
    if (!chains[seg.chainId]) chains[seg.chainId] = { segs: 0, items: [], blocked: false };
    chains[seg.chainId].segs++;
    if (seg.blocked === true) chains[seg.chainId].blocked = true;
    for (const it of seg.items ?? []) {
      chains[seg.chainId].items.push({ idx: seg.segmentIndex, p: +it.progress.toFixed(3), d: it.delta ?? 0, e: !!it.entering });
    }
  }
  return chains;
});

// ═══════════ 核心场景: 堵塞生长期的渐隐完整性 ═══════════
console.log('\n[核心] 堵塞生长: 精炼炉(6,10)+右口6格带→存货口 + 左口9格断头链；场景图 rAF 采样 40s');
await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 20000 });
await page.waitForTimeout(2500);
await page.bringToFront();

await page.evaluate(() => {
  const g = window.__game;
  g.clearAllPlaced();
  if (!g.placeAt('refining_unit', 6, 10, 0)) throw new Error('placeAt refining_unit 失败');
  if (g.spawnBelt([[8, 9], [8, 8], [8, 7], [8, 6], [8, 5], [8, 4]], 270) !== 6) throw new Error('主带创建失败');
  if (!g.placeAt('depot_loader', 7, 3, 180)) throw new Error('存货口创建失败');
  if (g.spawnBelt([[6, 9], [6, 8], [6, 7], [6, 6], [6, 5], [6, 4], [6, 3], [6, 2], [6, 1]], 270) !== 9) throw new Error('断头链创建失败');
  for (const h of g.world.query('BuildingComp')) {
    const c = g.world.getComponent(h, 'BuildingComp');
    if (c.definitionId === 'refining_unit') c.bufferInput[0] = { itemId: 'originium_ore', count: 999999 };
  }
  g.game.update();
});
await focus(7, 6, 1.0);

// 等首批物品上带/接近断头链尾（物品 ~1件/4s 轮流进两条带；首件走到断头链尾 ≈17s）
await page.waitForTimeout(15000);
const preState = await beltState();
const preDead = Object.entries(preState).find(([, c]) => c.segs === 9);
console.log(`  15s 预热: 断头链物品 ${preDead ? preDead[1].items.length : 0} 件（生长窗口即将开始）`);

// ── 场景图 rAF 采样（40s，不阻塞 node 侧截图）──
const sampling = page.evaluate(() => new Promise((resolve) => {
  const g = window.__game;
  let pointers = null;
  const find = (c) => {
    if (c.label === 'beltPointers') return c;
    for (const ch of c.children) { const r = find(ch); if (r) return r; }
    return null;
  };
  pointers = find(g.app.stage);
  if (!pointers) { resolve({ error: 'beltPointers 容器未找到' }); return; }
  const CHAIN_X = 416;
  const DUR = 40000;
  const samples = [];   // [t, [[sid,y,alpha,visible],...]]
  const itemSnaps = []; // [t, [[idx,progress,delta],...], blocked]
  const sidMap = new Map();
  let nextSid = 1;
  let frame = 0;
  const t0 = performance.now();
  const rec = () => {
    const t = Math.round(performance.now() - t0);
    const rows = [];
    for (const s of pointers.children) {
      if (!s.texture || s.tint === 0xffffff) continue; // 非箭头 sprite（白叠层/mask Graphics）
      if (Math.abs(s.position.x - CHAIN_X) > 30) continue;
      let sid = sidMap.get(s);
      if (sid === undefined) { sid = nextSid++; sidMap.set(s, sid); }
      rows.push([sid, Math.round(s.position.y * 10) / 10, Math.round(s.alpha * 1000) / 1000, s.visible ? 1 : 0]);
    }
    samples.push([t, rows]);
    if (frame % 8 === 0) {
      let chain = null;
      const byChain = new Map();
      for (const h of g.world.query('BeltSegmentComp')) {
        const seg = g.world.getComponent(h, 'BeltSegmentComp');
        let c = byChain.get(seg.chainId);
        if (!c) { c = []; byChain.set(seg.chainId, c); }
        c.push(seg);
      }
      for (const segs of byChain.values()) if (segs.length === 9) { chain = segs; break; }
      if (chain) {
        const items = [];
        let blocked = false;
        for (const seg of chain) {
          if (seg.blocked === true) blocked = true;
          for (const it of seg.items ?? []) {
            if (it.entering === true) continue;
            items.push([seg.segmentIndex ?? 0, Math.round(it.progress * 1000) / 1000, it.delta ?? 0]);
          }
        }
        itemSnaps.push([t, items, blocked ? 1 : 0]);
      }
    }
    frame++;
    if (performance.now() - t0 >= DUR) resolve({ samples, itemSnaps, nSprites: sidMap.size, fps: Math.round(frame / (DUR / 1000)) });
    else requestAnimationFrame(rec);
  };
  requestAnimationFrame(rec);
}));

// 采样窗口内每 4s 截图（10 张覆盖整个生长阶段）
for (let i = 1; i <= 10; i++) {
  await page.waitForTimeout(3900);
  await shot(`t29f-grow-${String(i).padStart(2, '0')}`);
}
const data = await sampling;
writeFileSync('log/t29f-samples.json', JSON.stringify(data));
if (data.error) {
  console.error(`  ❌ ${data.error} — 降级方式2（像素扫描）需手动执行`);
  await browser.close();
  process.exit(2);
}
console.log(`  采样: ${data.samples.length} 帧, ${data.nSprites} 支箭头 sprite, ~${data.fps}fps, 物品快照 ${data.itemSnaps.length} 份`);

// ── node 侧分析 ──
// d ↔ y 映射（断头链向上 270°: d=0 链首 y=640 边缘 → d=9 链尾 y=64 边缘）:
//   y(d) = (9.5 - d) * 64 + 32;  d(y) = 9.5 - (y - 32) / 64
const dOfY = (y) => 9.5 - (y - 32) / 64;
const yOfD = (d) => (9.5 - d) * 64 + 32;

// terminus 时间线（最前方停止物品 = min(idx+p over delta==0)）
const termTimeline = data.itemSnaps.map(([t, items, blocked]) => {
  let term = 9; // 无停止物品 = 真带尾
  const stoppedD = [];
  for (const [idx, p, delta] of items) {
    if (delta === 0) { stoppedD.push(idx + p); if (idx + p < term) term = idx + p; }
  }
  return { t, term, stoppedD, nStopped: stoppedD.length, nItems: items.length, blocked };
});
const termAt = (t) => {
  let best = termTimeline[0];
  for (const s of termTimeline) { if (s.t <= t) best = s; else break; }
  return best;
};

// 每支 sprite 的 (t,y,alpha,visible) 序列
const series = new Map();
for (const [t, rows] of data.samples) {
  for (const [sid, y, a, v] of rows) {
    let s = series.get(sid);
    if (!s) { s = []; series.set(sid, s); }
    s.push({ t, y, a, v });
  }
}

// (a) 硬切扫描: 相邻采样(≤250ms) alpha 全亮→消失/归零
let hardCuts = 0;
const hardCutLog = [];
// 渐隐事件（可见段结束 = 消失点）
const fadeEvents = [];
let brightEnds = 0; // 序列在全亮时戛然而止（疑似击杀/异常）
for (const [sid, s] of series) {
  // 可见段切分
  const segs = [];
  let cur = [];
  for (const pt of s) {
    if (pt.v === 1) cur.push(pt);
    else if (cur.length > 0) { segs.push(cur); cur = []; }
  }
  const endedByWindow = s.length > 0 && s[s.length - 1].t > SAMPLE_MS - 400;
  if (cur.length > 0 && !endedByWindow) brightEnds++;
  for (const seg of segs) {
    const last = seg[seg.length - 1];
    if (last.t > SAMPLE_MS - 400) continue; // 窗口尾截断的段不算
    // 硬切判定: 段末前 ≤250ms 内还有 ≥0.85 全亮样本
    const bright = seg.filter((p) => p.a >= 0.85 && last.t - p.t <= 250);
    if (bright.length > 0) {
      hardCuts++;
      hardCutLog.push({ sid, t: last.t, aLast: last.a, aPrevBright: bright[bright.length - 1].a, dt: last.t - bright[bright.length - 1].t });
    }
    // 渐隐判定: 段末 900ms 内存在连续 3 采样严格递减（末值 ≥0.03）
    const win = seg.filter((p) => last.t - p.t <= 900);
    let triple = false;
    for (let i = 0; i + 2 < win.length; i++) {
      if (win[i].a > win[i + 1].a && win[i + 1].a > win[i + 2].a && win[i + 2].a >= 0.03) { triple = true; break; }
    }
    fadeEvents.push({
      sid, t: last.t, aLast: last.a, yLast: last.y, d: +dOfY(last.y).toFixed(3),
      gradual: triple, nSamples: seg.length,
    });
  }
}

// (b) 堵塞物品区无可见箭头: 前沿之后 >0.45 格的可见样本，若处于某停止物品中心
//     ±0.35 格内 = 滑入物品身下的锁定出场口渐隐（物品 zIndex 0.5 盖住指针 0.4，
//     合法吞噬）; 只有"前沿之后且不邻近任何停止物品"的可见箭头 = 真入侵。
let intrusion = 0;
let coveredFades = 0;
const intrusionLog = [];
let checkedVisible = 0;
for (const [t, rows] of data.samples) {
  const st = termAt(t);
  const frontY = yOfD(st.term);
  for (const [sid, y, a, v] of rows) {
    if (!v || a <= 0.05) continue;
    if (y < 40 || y > CHAIN_BOTTOM_Y) continue; // 带外等待区（遮罩外）
    checkedVisible++;
    if (y >= frontY - 0.45 * CELL) continue; // 前沿渐隐容差内
    const dArrow = dOfY(y);
    let nearStopped = Infinity;
    for (const sd of st.stoppedD) nearStopped = Math.min(nearStopped, Math.abs(sd - dArrow));
    if (nearStopped <= 0.35) { coveredFades++; continue; } // 物品身下渐隐
    intrusion++;
    intrusionLog.push({ t: +(t / 1000).toFixed(2), sid, d: +dArrow.toFixed(3), a, term: +st.term.toFixed(3), nearestStopped: +nearStopped.toFixed(3) });
  }
}

// (c)+(d) 渐隐事件 vs terminus: 每个事件的位置 = 当时或更早的前沿
const evAnalysis = fadeEvents.map((e) => {
  const st = termAt(e.t);
  // 历史前沿是否曾到达 e.d（锁定时刻）
  let lockGap = Infinity;
  for (const s of termTimeline) {
    if (s.t > e.t) break;
    lockGap = Math.min(lockGap, Math.abs(s.term - e.d));
  }
  return { ...e, termNow: +st.term.toFixed(3), lockGap: +lockGap.toFixed(3) };
});
evAnalysis.sort((a, b) => a.t - b.t);
const frontFades = evAnalysis.filter((e) => e.d >= e.termNow - 0.35); // 在前沿处（含锁定旧前沿）渐隐
const gradualOk = evAnalysis.filter((e) => e.gradual).length;

console.log(`\n  terminus 阶梯: ${termTimeline.filter((s, i) => i === 0 || Math.abs(s.term - termTimeline[i - 1].term) > 0.01)
  .map((s) => `t=${s.t}s→d${s.term.toFixed(2)}`).join('  ')}`);

ok(hardCuts === 0, `(a) 硬切 = 0（全亮→消失 0 次；brightEnds 序列全亮截断 = ${brightEnds}，窗口尾除外）`);
ok(gradualOk === fadeEvents.length && fadeEvents.length > 0,
  `(a) 渐隐完整: ${gradualOk}/${fadeEvents.length} 支次消失前 900ms 内 alpha 连续 3 采样严格递减`);
ok(intrusion === 0, `(b) 堵塞物品区无可见箭头: 检查 ${checkedVisible} 个可见样本, 物品身下合法吞噬渐隐 ${coveredFades} 个, 真入侵 ${intrusion} 个${intrusion ? ' ' + JSON.stringify(intrusionLog.slice(0, 5)) : ''}`);
ok(frontFades.length >= 6, `(c) 前沿吞噬循环持续: ${frontFades.length}/${evAnalysis.length} 次渐隐发生在(当前或锁定)前沿 d≥term-0.35`);
const dSpread = [...new Set(evAnalysis.map((e) => e.d.toFixed(2)))].sort();
ok(evAnalysis.length >= 6 && dSpread.length >= 3,
  `(d) 每支走到各自停止位置渐隐: 渐隐位置阶梯 d = {${dSpread.join(', ')}}（≥3 个不同前沿 = 逐支锁定而非全被拉到同一当前终点硬切）`);
console.log(`  渐隐事件明细: ${evAnalysis.map((e) => `t=${(e.t / 1000).toFixed(1)}s d=${e.d} α末=${e.aLast} term=${e.termNow} 锁差=${e.lockGap}`).join(' | ')}`);

// ═══════════ 快速回归 ═══════════
console.log('\n[回归a] 两条异时创建空带: 3.2s 间隔创建，10s 后 0.5s 连拍 2 张（流动 + 相位不同）');
await page.evaluate(() => window.__game.clearAllPlaced());
await focus(6, 7, 0.6);
const spawnBeltUp = (x, yBottom, len) => page.evaluate(({ x, yBottom, len }) => {
  const cells = [];
  for (let i = 0; i < len; i++) cells.push([x, yBottom - i]);
  return window.__game.spawnBelt(cells, 270);
}, { x, yBottom, len });
const ra1 = await spawnBeltUp(4, 9, 5);
await page.waitForTimeout(3200);
const ra2 = await spawnBeltUp(8, 9, 5);
ok(ra1 === 5 && ra2 === 5, `回归a 前置: 两条 5 格空带创建（${ra1}/${ra2}）`);
await page.waitForTimeout(10000);
const arrowSnap = () => page.evaluate(() => {
  const g = window.__game;
  let pointers = null;
  const find = (c) => {
    if (c.label === 'beltPointers') return c;
    for (const ch of c.children) { const r = find(ch); if (r) return r; }
    return null;
  };
  pointers = find(g.app.stage);
  const rows = [];
  for (const s of pointers.children) {
    if (!s.texture || s.tint === 0xffffff) continue;
    const x = s.position.x;
    if (Math.abs(x - 4 * 64 - 32) < 30) rows.push(['A', Math.round(s.position.y), +(s.alpha.toFixed(2))]);
    else if (Math.abs(x - 8 * 64 - 32) < 30) rows.push(['B', Math.round(s.position.y), +(s.alpha.toFixed(2))]);
  }
  return rows;
});
await shot('t29f-reg-a1');
const snap1 = await arrowSnap();
await page.waitForTimeout(500);
const snap2 = await arrowSnap();
await shot('t29f-reg-a2');
const moved = (arr) => arr.filter((r) => r[2] > 0.5).map((r) => r[1]);
const a1 = moved(snap1.filter((r) => r[0] === 'A')), a2 = moved(snap2.filter((r) => r[0] === 'A'));
const b1 = moved(snap1.filter((r) => r[0] === 'B')), b2 = moved(snap2.filter((r) => r[0] === 'B'));
const movedA = a1.some((y) => !a2.includes(y)) || a2.some((y) => !a1.includes(y));
const movedB = b1.some((y) => !b2.includes(y)) || b2.some((y) => !b1.includes(y));
const phaseA = a1.map((y) => ((y % 64) + 64) % 64);
const phaseB = b1.map((y) => ((y % 64) + 64) % 64);
const minPhaseDiff = Math.min(...phaseA.flatMap((pa) => phaseB.map((pb => {
  let d = Math.abs(pa - pb); if (d > 32) d = 64 - d; return d;
}))), 999);
ok(movedA && movedB, `回归a: 两带均在流动（A ${a1.length}→${a2.length} 支位置变化=${movedA}, B ${b1.length}→${b2.length}=${movedB}）`);
ok(a1.length > 0 && b1.length > 0 && minPhaseDiff > 8, `回归a: 相位不同（最小相位差 ${minPhaseDiff.toFixed(1)}px > 8px）→ t29f-reg-a1/a2.png`);

console.log('\n[回归b] 取货口→带: depot_unloader(3,10) + 8 格带，8s 窗口内物品应出现在带首格（前导无空格）');
await page.evaluate(() => window.__game.clearAllPlaced());
await focus(4, 6, 0.6);
await page.evaluate(() => window.__game.placeAt('depot_unloader', 3, 10, 0));
const rb = await spawnBeltUp(4, 9, 8);
ok(rb === 8, `回归b 前置: 8 格带创建（${rb}）`);
let minDSeen = Infinity;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(200);
  const st = await beltState();
  const ch = Object.values(st).find((c) => c.segs === 8);
  if (!ch) continue;
  for (const it of ch.items) {
    if (it.e) continue;
    const d = it.idx + it.p;
    if (d < minDSeen) minDSeen = d;
  }
}
await shot('t29f-reg-b1');
ok(minDSeen < 0.9, `回归b: 窗口内最前物品 d=${minDSeen === Infinity ? 'n/a' : minDSeen.toFixed(3)}（<0.9 = 带首格有物品，前导无空格）→ t29f-reg-b1.png`);

console.log('\n[回归c] 满载流动带: 精炼炉(2,10)+6 格带+存货口，输入 999999，物品 ≥6 后截图 + 箭头-物品最近距离');
await page.evaluate(() => {
  const g = window.__game;
  g.clearAllPlaced();
  g.placeAt('refining_unit', 2, 10, 0);
  g.spawnBelt([[3, 9], [3, 8], [3, 7], [3, 6], [3, 5], [3, 4]], 270);
  g.placeAt('depot_loader', 2, 3, 180);
  for (const h of g.world.query('BuildingComp')) {
    const c = g.world.getComponent(h, 'BuildingComp');
    if (c.definitionId === 'refining_unit') c.bufferInput[0] = { itemId: 'originium_ore', count: 999999 };
  }
  g.game.update();
});
await focus(3, 7, 0.6);
let cItems = 0;
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(500);
  const st = await beltState();
  const ch = Object.values(st).find((c) => c.segs === 6);
  cItems = ch ? ch.items.filter((it) => !it.e).length : 0;
  if (cItems >= 6) break;
}
const dist = await page.evaluate(() => {
  const g = window.__game;
  let pointers = null;
  const find = (c) => {
    if (c.label === 'beltPointers') return c;
    for (const ch of c.children) { const r = find(ch); if (r) return r; }
    return null;
  };
  pointers = find(g.app.stage);
  // 物品世界坐标（直段向上 270°）
  const itemPts = [];
  for (const h of g.world.query('BeltSegmentComp')) {
    const seg = g.world.getComponent(h, 'BeltSegmentComp');
    const pos = g.world.getComponent(h, 'Position');
    if (!seg || !pos || seg.isCorner) continue;
    const rad = (seg.direction * Math.PI) / 180;
    const ang = seg.direction === 270 ? (3 * Math.PI) / 2 : rad;
    for (const it of seg.items ?? []) {
      itemPts.push({
        x: pos.x + 32 + Math.cos(ang) * (it.progress - 0.5) * 64,
        y: pos.y + 32 + Math.sin(ang) * (it.progress - 0.5) * 64,
      });
    }
  }
  let minDist = Infinity;
  let visibleArrows = 0;
  for (const s of pointers.children) {
    if (!s.texture || s.tint === 0xffffff) continue;
    if (s.alpha <= 0.05 || !s.visible) continue;
    visibleArrows++;
    for (const p of itemPts) {
      const d = Math.hypot(s.position.x - p.x, s.position.y - p.y);
      if (d < minDist) minDist = d;
    }
  }
  return { minDist: +minDist.toFixed(1), visibleArrows, nItems: itemPts.length };
});
await shot('t29f-reg-c1');
ok(cItems >= 6, `回归c 前置: 满载带上物品 ${cItems} 件（期望 ≥6）`);
ok(dist.nItems > 0 && dist.minDist >= 24, `回归c: 箭头-物品最近距离 ${dist.minDist}px（≥24px 接触距离 = 物品下无箭头; 可见箭头 ${dist.visibleArrows} 支, 物品 ${dist.nItems} 件）→ t29f-reg-c1.png`);

writeFileSync('log/t29f-result.json', JSON.stringify({
  hardCuts, hardCutLog, brightEnds,
  fades: evAnalysis, gradualOk, fadeTotal: fadeEvents.length,
  intrusion, intrusionLog, coveredFades, checkedVisible,
  frontFades: frontFades.length,
  regA: { a1, a2, b1, b2, minPhaseDiff }, regB: { minDSeen }, regC: { ...dist, cItems },
}, null, 1));

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
