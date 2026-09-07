// T2.29-e 截图像素核验 v3 — node scripts/_t29e-imgscan.mjs
// 颜色分类（实测校准）:
//   黄带身 (255,239,0) / 灰网格 (230,228,228) / 黄箭头 #DFB615≈(223,182,21) (r−g=41)
//   红堵带 (179,7,0) / 堵塞箭头 #E6956F≈(230,149,111) (r−g=81) 及 alpha 混合
//   物品: 暗(32,32,32)/棕(174,115,76)/琥珀高光(部分 r−g≥55 → 会被 arrowS 误报 →
//   S2 用「静态排除」过滤: 同一 d 连续 ≥10/11 帧出现的段 = 物品纹理, 非箭头)
import sharp from 'sharp';

const CL = {
  arrowY: (r, g, b) => r >= 200 && r - g >= 30 && g <= 215 && b <= 60,
  arrowS: (r, g, b) => r >= 190 && r - g >= 55 && b <= 150,
  itemD: (r, g, b) => r < 210 && g < 130 && b < 130,
};

async function loadRaw(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, ch: info.channels };
}

function rowClassify(img, xs, xe, y0, y1, classes) {
  const rows = [];
  for (let y = y0; y < y1; y++) {
    const cnt = Object.fromEntries(Object.keys(classes).map((k) => [k, 0]));
    for (let x = xs; x < xe; x++) {
      const i = (y * img.w + x) * img.ch;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      for (const [k, fn] of Object.entries(classes)) if (fn(r, g, b)) cnt[k]++;
    }
    rows.push({ y, ...cnt });
  }
  return rows;
}

function blobsOf(rows, key, minCount) {
  const segs = [];
  let cur = null;
  for (const r of rows) {
    if (r[key] >= minCount) {
      if (cur === null) cur = { y0: r.y, y1: r.y, peak: r[key], sum: r[key], n: 1 };
      else { cur.y1 = r.y; cur.peak = Math.max(cur.peak, r[key]); cur.sum += r[key]; cur.n++; }
    } else if (cur !== null) { segs.push(cur); cur = null; }
  }
  if (cur !== null) segs.push(cur);
  return segs;
}

// ═══════════ S1: 创建中指针覆盖 ═══════════
console.log('═══ S1 创建中指针覆盖（zoom0.8, 带 x=5 中心 x=640, 链首(5,7)底@y528, 每格51.2px）═══');
{
  const XS = 632, XE = 648, Y0 = 169, Y1 = 528, CELL = 51.2, YBOT = 528;
  for (let s = 1; s <= 4; s++) {
    const img = await loadRaw(`log/t29e-s1-${s}.png`);
    const rows = rowClassify(img, XS, XE, Y0, Y1, CL);
    const blobs = blobsOf(rows, 'arrowY', 3);
    const perCell = new Array(7).fill(0);
    for (const b of blobs) {
      const yMid = (b.y0 + b.y1) / 2;
      const idx = Math.min(6, Math.max(0, Math.floor((YBOT - yMid) / CELL)));
      perCell[idx]++;
    }
    console.log(`  s1-${s}: 箭头段 ${blobs.length}（y=${blobs.map((b) => `${b.y0}~${b.y1}`).join(',') || '—'}）逐格支数 [${perCell.join(' ')}]（0=链首(5,7)…6=链尾(5,1)）`);
  }
  console.log('  判定: s1-k 中格 0..len-1 应每格 ≥1 支（len: 1/2/4/7）——新段即时覆盖');
}

// ═══════════ S2: 堵塞虚拟终点 ═══════════
console.log('\n═══ S2 堵塞虚拟终点（zoom1.0, 断头链 x=6 中心576, d=0@y624 向上, 每格64px）═══');
{
  const XS = 560, XE = 592, Y0 = 48, Y1 = 624, CELL = 64, D0Y = 624;
  const dOf = (y) => (D0Y - y) / CELL;
  const files = [];
  for (let i = 1; i <= 3; i++) files.push(`log/t29e-s2-pre-${i}.png`);
  for (let i = 1; i <= 8; i++) files.push(`log/t29e-s2-${i}.png`);
  const frames = [];
  for (const f of files) {
    const img = await loadRaw(f);
    const rows = rowClassify(img, XS, XE, Y0, Y1, CL);
    const arrows = blobsOf(rows, 'arrowS', 2);
    frames.push({ f, arrows });
  }
  // 静态排除: 物品琥珀纹理在全部 11 帧固定 d 重复出现 → 归为物品纹理
  const key = (b) => Math.round(dOf((b.y0 + b.y1) / 2) * 20) / 20;
  const occur = new Map();
  for (const { arrows } of frames) for (const b of arrows) occur.set(key(b), (occur.get(key(b)) ?? 0) + 1);
  const staticKeys = new Set([...occur.entries()].filter(([, n]) => n >= 10).map(([k]) => k));
  console.log(`  静态纹理位（≥10/11 帧同位 = 物品琥珀纹理，排除）: ${[...staticKeys].join(', ')}`);
  for (const fr of frames) fr.trans = fr.arrows.filter((b) => !staticKeys.has(key(b)));
  console.log('\n  排除后每帧【动态箭头】（应为链首自由窗内的移动指针）:');
  for (const { f, trans } of frames) {
    console.log(`    ${f.split('/').pop()}: ${trans.length} 支 @ ${trans.map((b) => `d=${dOf((b.y0 + b.y1) / 2).toFixed(2)}(y${b.y0}~${b.y1},pk${b.peak})`).join(' ') || '—（指针在遮罩外/被物品覆盖相位）'}`);
  }
  // (a) 位移
  console.log('\n  (a) 动态箭头帧间位移（pre 0.5s 期望 Δd≈+0.25；正式 0.4s 期望 Δd≈+0.20）:');
  for (let k = 1; k < frames.length; k++) {
    const A = frames[k - 1].trans, B = frames[k].trans;
    const tag = files[k].split('/').pop();
    if (B.length === 0) { console.log(`    ${tag}: 无可见动态箭头（该相位指针在带尾余量外/物品下方）`); continue; }
    for (const bb of B) {
      const bd = dOf((bb.y0 + bb.y1) / 2);
      let best = null, bestD = Infinity;
      for (const aa of A) { const ad = dOf((aa.y0 + aa.y1) / 2); const d = bd - ad; if (Math.abs(d) < Math.abs(bestD)) { bestD = d; best = aa; } }
      console.log(`    ${tag}: 箭头 d=${bd.toFixed(2)}${best ? ` ← 前帧 ${dOf((best.y0 + best.y1) / 2).toFixed(2)}（Δd=${bestD.toFixed(2)}）` : '（新滑入带缘）'}`);
    }
  }
  // (b) 渐隐
  console.log('\n  (b) 渐隐: 动态箭头轨迹上 peak/覆盖行数变化（靠近物品 d≈0.3+ 时被物品剪裁+alpha 渐隐 → 段缩短、peak 下降）:');
  for (const { f, trans } of frames) {
    console.log(`    ${f.split('/').pop()}: ${trans.map((b) => `d=${dOf((b.y0 + b.y1) / 2).toFixed(2)} pk=${b.peak} h=${b.y1 - b.y0 + 1}px mass=${b.sum}`).join(' | ') || '—'}`);
  }
  // (c) 物品区无箭头
  console.log('\n  (c) 物品占据区（d>0.75，即链首停止物品格心以上）动态箭头核验:');
  for (const { f, trans } of frames) {
    const bad = trans.filter((b) => dOf((b.y0 + b.y1) / 2) > 0.75);
    console.log(`    ${f.split('/').pop()}: ${bad.length === 0 ? '✅ 0（无箭头进入物品区）' : '❌ ' + bad.map((b) => `d=${dOf((b.y0 + b.y1) / 2).toFixed(2)}`).join(',')}`);
  }
  // (d) 闪烁: 每帧动态段 ≤2，帧间轨迹单调（Δd≥0）
  const multi = frames.filter((fr) => fr.trans.length > 2);
  console.log(`\n  (d) 闪烁核验: 每帧动态段 ≤2 → ${multi.length === 0 ? '✅ 全部 ≤2' : '❌ ' + multi.map((m) => m.f).join(',')}`);
}

// ═══════════ S3 ═══════════
console.log('\n═══ S3a 两条异时空带（zoom0.6: A x带[546,562) B x带[709,725), cells y=5..9 → y304..496）═══');
{
  const CELL = 38.4, Y0 = 304, Y1 = 496, YBOT = 496;
  const belts = [{ n: 'A(x=4)', xs: 555, xe: 571 }, { n: 'B(x=8)', xs: 709, xe: 725 }];
  const shots = [];
  for (let s = 1; s <= 2; s++) {
    const img = await loadRaw(`log/t29e-s3a-${s}.png`);
    const res = belts.map((b) => {
      const rows = rowClassify(img, b.xs, b.xe, Y0, Y1, CL);
      return { arr: blobsOf(rows, 'arrowY', 2) };
    });
    shots.push(res);
    for (let i = 0; i < 2; i++) {
      console.log(`  s3a-${s} ${belts[i].n}: 箭头 ${res[i].arr.length} 支 @ d=${res[i].arr.map((b) => ((YBOT - (b.y0 + b.y1) / 2) / CELL).toFixed(2)).join(',')}（d=0@带首下缘, 链长5）`);
    }
  }
  console.log('  位移（0.5s 期望 Δd≈+0.25）与相位（d mod 1 两带应不同）:');
  const dOfB = (b) => (YBOT - (b.y0 + b.y1) / 2) / CELL;
  for (let i = 0; i < 2; i++) {
    const A = shots[0][i].arr, B = shots[1][i].arr;
    for (const bb of B) {
      let best = null, bestD = Infinity;
      for (const aa of A) { const d = dOfB(bb) - dOfB(aa); if (Math.abs(d) < Math.abs(bestD)) { bestD = d; best = aa; } }
      console.log(`    ${belts[i].n}: d=${dOfB(bb).toFixed(2)}${best ? ` ← ${dOfB(best).toFixed(2)}（Δd=${bestD.toFixed(2)}）` : '（新入）'}`);
    }
  }
  const ph = (arr) => arr.map((b) => (dOfB(b) % 1).toFixed(2));
  console.log(`    相位: A=[${ph(shots[0][0].arr).join(',')}] B=[${ph(shots[0][1].arr).join(',')}]`);
}

console.log('\n═══ S3b 取货口→带（zoom0.6: 带x=4 中心640, cells(4,2)顶..(4,9)底 → y227..534）═══');
{
  const CELL = 38.4, YTOP = 227.2;
  for (let s = 1; s <= 2; s++) {
    const img = await loadRaw(`log/t29e-s3b-${s}.png`);
    const rows = rowClassify(img, 632, 648, Math.round(YTOP), Math.round(YTOP + 8 * CELL), CL);
    const items = blobsOf(rows, 'itemD', 5);
    const arrows = blobsOf(rows, 'arrowY', 2);
    const cells = new Array(8).fill('.');
    for (const b of items) { const i = Math.floor(((b.y0 + b.y1) / 2 - YTOP) / CELL); if (i >= 0 && i < 8) cells[i] = 'I'; }
    for (const b of arrows) { const i = Math.floor(((b.y0 + b.y1) / 2 - YTOP) / CELL); if (i >= 0 && i < 8 && cells[i] === '.') cells[i] = 'A'; }
    const top = cells.findIndex((c) => c !== '.');
    const leadOk = top >= 0 && cells[top] === 'A' && cells.includes('I');
    console.log(`  s3b-${s}: [${cells.join('')}]（左=链尾(4,2)顶…右=链首(4,9)底）${leadOk ? '✅ 物品前方（至链尾）全被箭头覆盖，无空白格' : '❌ 物品前方存在空白/最前实体是物品'}`);
  }
}

console.log('\n═══ S3c 满载流动带（zoom0.6: 带x=3 中心640, cells(3,4)顶..(3,9)底 → y354..534）═══');
{
  const CELL = 38.4, YTOP = 353.6;
  const img = await loadRaw('log/t29e-s3c-1.png');
  const rows = rowClassify(img, 632, 648, Math.round(YTOP), Math.round(YTOP + 6 * CELL), CL);
  const items = blobsOf(rows, 'itemD', 5);
  const arrows = blobsOf(rows, 'arrowY', 2);
  const cells = new Array(6).fill('.');
  for (const b of items) { const i = Math.floor(((b.y0 + b.y1) / 2 - YTOP) / CELL); if (i >= 0 && i < 6) cells[i] = 'I'; }
  for (const b of arrows) { const i = Math.floor(((b.y0 + b.y1) / 2 - YTOP) / CELL); if (i >= 0 && i < 6 && cells[i] === '.') cells[i] = 'A'; }
  const free = arrows.filter((a) => {
    const am = (a.y0 + a.y1) / 2;
    return items.every((it) => Math.abs((it.y0 + it.y1) / 2 - am) > CELL * 0.45);
  });
  console.log(`  s3c-1: [${cells.join('')}]（左=链尾(3,4)顶…右=链首(3,9)底）物品段 ${items.length}, 箭头段 ${arrows.length}${free.length ? `，❌物品间隙独立箭头 ${free.length} 支 @d=${free.map((b) => (((b.y0 + b.y1) / 2 - YTOP) / CELL).toFixed(2)).join(',')}` : '，物品流下方无独立指针 ✅'}`);
}
console.log('\n扫描完成。');
