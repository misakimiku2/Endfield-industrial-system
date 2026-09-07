// T2.29-e S2 堵塞虚拟终点 — 像素级核验（颜色分类 + 帧差流动检测）
// node scripts/_t29e-s2scan.mjs
//
// 几何: focus(7,6,1.0) → cam=(480,416); 屏幕 = world − (480,416) + (640,400)
//   断头链 x=6: 带身世界 x 384..448 → 屏幕 x 544..608（带身实际 ~556..596）
//   d=0（链首格(6,9)下缘）@ 屏幕 y=624，d=9（链尾格(6,1)上缘）@ y=48，每格 64px
//   满堵 9 物品 @ d=0.5..8.5 → 格心 y = 592−64k
//   实现（BeltPointerQueue.stoppedFront = min total 停止物品）: 渐隐中心 d=0.5 →
//   箭头可见窗 d∈[−0.125,0.625] → y∈[584,632]（渐隐带 d∈[0.375,0.625] → y∈[584,600]）
// 颜色（实测 s2-1）: 红带 (179,7,0) / 物品棕 (174,115,76) / 物品高光 (210,187,91) /
//   黄带 (255,239,0) / 黄带上箭头 #DFB615≈(223,182,21) / 堵塞箭头 tint≈#E6956F(230,149,111)
import sharp from 'sharp';

const Y0 = 48, Y1 = 624;       // 链尾顶 → 链首底
const XS = 558, XE = 594;      // 带身内带
const D0Y = 624;               // d=0 的屏幕 y
const CELL = 64;
const dOf = (y) => (D0Y - y) / CELL;

async function loadRaw(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, ch: info.channels };
}

/** 逐行分类计数: 红=带身, item=物品(棕/高光), arrow=箭头(salmon 或 yellow) */
function classify(img) {
  const rows = [];
  for (let y = Y0; y < Y1; y++) {
    let red = 0, item = 0, arrow = 0, gray = 0;
    for (let x = XS; x < XE; x++) {
      const i = (y * img.w + x) * img.ch;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (r >= 160 && r <= 195 && g < 40 && b < 40) red++;
      else if (g >= 55 && r < 250 && !(r >= 215 && g >= 225)) {
        // 物品棕(174,115,76)~高光(210,187,91): g 高、b 中
        item++;
      } else if (r >= 196 && g >= 90 && b >= 55 && r - g >= 55 && r - g <= 110) arrow++;
      else if (r >= 200 && g >= 160 && b < 80) arrow++; // 黄箭头(未混合)
      else gray++;
    }
    rows.push({ y, red, item, arrow, gray });
  }
  return rows;
}

/** 从行分类结果提取实体段 */
function blobsOf(rows, pick, minCount, minY = Y0, maxY = Y1) {
  const segs = [];
  let cur = null;
  for (const r of rows) {
    const v = pick(r);
    const inRange = r.y >= minY && r.y < maxY;
    if (v >= minCount && inRange) {
      if (cur === null) cur = { y0: r.y, y1: r.y, peak: v, sum: v, n: 1 };
      else { cur.y1 = r.y; cur.peak = Math.max(cur.peak, v); cur.sum += v; cur.n++; }
    } else if (cur !== null) { segs.push(cur); cur = null; }
  }
  if (cur !== null) segs.push(cur);
  return segs.map((s) => ({
    yMid: (s.y0 + s.y1) / 2,
    d: +dOf((s.y0 + s.y1) / 2).toFixed(2),
    h: s.y1 - s.y0 + 1,
    peak: s.peak,
    mass: s.sum,
  }));
}

const files = [];
for (let i = 1; i <= 3; i++) files.push(`log/t29e-s2-pre-${i}.png`);
for (let i = 1; i <= 8; i++) files.push(`log/t29e-s2-${i}.png`);

const frames = [];
for (const f of files) {
  const img = await loadRaw(f);
  const rows = classify(img);
  frames.push({ f, rows });
}

console.log('═══ S2 静态分类: 物品格占用 + 箭头位置（每帧）═══');
// 物品格: d=k+0.5 的物品占据 y = (592−64k)±22 → 检查每格 item 行数
for (const { f, rows } of frames) {
  const itemBlobs = blobsOf(rows, (r) => r.item, 12);
  const arrowBlobs = blobsOf(rows, (r) => r.arrow, 6);
  // (c) 物品占据区之外的箭头 = 渐隐窗外（d>0.75 → y<576）的 arrow 行
  const arrowsBeyond = arrowBlobs.filter((b) => dOf(b.yMid) > 0.75);
  const cells = new Array(9).fill('.');
  for (const b of itemBlobs) {
    const ci = Math.round(dOf(b.yMid) - 0.5);
    if (ci >= 0 && ci < 9) cells[ci] = 'I';
  }
  for (const b of arrowBlobs) {
    const ci = Math.round(dOf(b.yMid) - 0.5);
    if (ci >= 0 && ci < 9 && cells[ci] === '.') cells[ci] = 'A';
  }
  console.log(`${f.split('/').pop()}: 物品格 [${cells.join('')}]（0=链首(6,9)底…8=链尾(6,1)顶）物品blob=${itemBlobs.length} 箭头blob=${arrowBlobs.length}`);
  if (itemBlobs.length) console.log(`   物品 @d=${itemBlobs.map((b) => b.d).join(',')}（期望 0.5,1.5,…,8.5）`);
  if (arrowBlobs.length) console.log(`   箭头 @d=[${arrowBlobs.map((b) => `${b.d}(h${b.h},pk${b.peak})`).join(' ')}]`);
  if (arrowsBeyond.length) console.log(`   ⚠ d>0.75（物品区内）可见箭头 ${arrowsBeyond.length} 支 @d=${arrowsBeyond.map((b) => b.d).join(',')}`);
}

// ── (a)+(d) 帧差流动: 连续帧逐像素 diff → 移动箭头显示为 diff 质量沿 y 分布 ──
console.log('\n═══ (a)(d) 帧差流动核验（静态物品/网格 diff=0；只有移动箭头产生 diff）═══');
const diffs = [];
for (let k = 1; k < frames.length; k++) {
  const A = await loadRaw(files[k - 1]), B = await loadRaw(files[k]);
  const perRow = [];
  for (let y = Y0; y < Y1; y++) {
    let n = 0;
    for (let x = XS; x < XE; x++) {
      const ia = (y * A.w + x) * A.ch, ib = (y * B.w + x) * B.ch;
      const d = Math.abs(A.data[ia] - B.data[ib]) + Math.abs(A.data[ia + 1] - B.data[ib + 1]) + Math.abs(A.data[ia + 2] - B.data[ib + 2]);
      if (d > 60) n++;
    }
    perRow.push({ y, n });
  }
  const dBlobs = blobsOf(perRow, (r) => r.n, 4);
  diffs.push({ pair: `${files[k - 1].split('/').pop()}→${files[k].split('/').pop()}`, blobs: dBlobs });
  const desc = dBlobs.length
    ? dBlobs.map((b) => `y${b.yMid.toFixed(0)}(d=${b.d},h${b.h},pk${b.peak})`).join(' ')
    : '（无运动痕迹）';
  console.log(`${diffs[k - 1].pair}: 运动痕迹 ${dBlobs.length} 处 @ ${desc}`);
}

// 运动方向: 帧差只给"变化"，方向用 (a) 的跨帧箭头位移:
console.log('\n═══ (a) 箭头帧间位移（arrow blob 最近匹配，期望 Δd=+0.2/帧（0.4s）/ +0.25（0.5s pre））═══');
for (let k = 1; k < frames.length; k++) {
  const A = blobsOf(frames[k - 1].rows, (r) => r.arrow, 6);
  const B = blobsOf(frames[k].rows, (r) => r.arrow, 6);
  if (B.length === 0) { console.log(`${files[k].split('/').pop()}: 无箭头 blob（箭头在遮罩外等待段，合法周期相位）`); continue; }
  for (const bb of B) {
    let best = null, bestD = Infinity;
    for (const aa of A) { const d = bb.d - aa.d; if (Math.abs(d) < Math.abs(bestD)) { bestD = d; best = aa; } }
    console.log(`${files[k].split('/').pop()}: 箭头 d ${best ? best.d : '—'} → ${bb.d}（Δd=${best ? bestD.toFixed(2) : '新入窗'}，期望≈+0.20~0.25）peak ${best ? best.peak : '—'}→${bb.peak}`);
  }
}

// ── (b) 渐隐: 渐隐带（d∈[0.375,0.625] → y∈[584,600]）与全显带（d∈[0.125,0.375] → y∈[600,616]）箭头 peak 对比 ──
console.log('\n═══ (b) 渐隐核验: 各帧箭头 peak（salmon 行数峰值）按 d 列出（接近 d=0.625 应递减）═══');
for (const { f, rows } of frames) {
  const arrowBlobs = blobsOf(rows, (r) => r.arrow, 4);
  console.log(`${f.split('/').pop()}: ${arrowBlobs.map((b) => `d=${b.d} pk=${b.peak} mass=${b.mass}`).join(' | ') || '（无箭头）'}`);
}
console.log('\n扫描完成。');
