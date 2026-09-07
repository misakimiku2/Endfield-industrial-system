// T2.29-c 截图像素扫描 — node scripts/_t29c-imgscan.mjs
// 用 sharp 对 log/t29c-s*.png 做逐行亮度分析，定位传送带上的指针/物品位置，
// 为视觉结论提供像素级证据（对比 3 张 S1 连拍: 指针位移/相位/静止; S2: 前导空格;
// S3: 物品间隙无指针）。
import sharp from 'sharp';

const CELL_PX = 64 * 0.6; // 38.4

// 相机几何: focus(gx,gy,zoom) → cam=( (gx+.5)*64, (gy+.5)*64 ), viewport 1280×800
// screen = (world − cam)×zoom + (640,400)
const cam = (gx, gy) => ({ cx: (gx + 0.5) * 64, cy: (gy + 0.5) * 64 });
function screenY(worldY, c, zoom = 0.6) { return (worldY - c.cy) * zoom + 400; }
function screenX(worldX, c, zoom = 0.6) { return (worldX - c.cx) * zoom + 640; }

async function loadRaw(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}

/** 沿竖直带（屏幕 x 带 [x0,x1)，y ∈ [y0,y1)）逐行求平均 RGB 与亮度 */
function rowProfile(img, x0, x1, y0, y1) {
  const rows = [];
  for (let y = y0; y < y1; y++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * img.ch;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
    rows.push({ y, r: r / n, g: g / n, b: b / n, lum: (r + g + b) / (3 * n) });
  }
  return rows;
}

/**
 * 检测带上的"实体"行（指针=小暗黄痕、物品=大暗斑）: 与带身基线（同行滑动中位数）
 * 比较的亮度下降。返回连续段列表 { yMid, depth, kind }。
 */
function detectBlobs(rows, minDepth) {
  // 滑动基线: 每行取 ±9 行的中位数亮度作为带身参考（指针/物品较窄，中位数抗污染）
  const lums = rows.map((r) => r.lum);
  const base = lums.map((_, i) => {
    const win = [];
    for (let j = Math.max(0, i - 9); j <= Math.min(lums.length - 1, i + 9); j++) win.push(lums[j]);
    win.sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)];
  });
  const segs = [];
  let cur = null;
  rows.forEach((r, i) => {
    const depth = base[i] - r.lum;
    if (depth > minDepth) {
      if (cur === null) cur = { y0: r.y, y1: r.y, maxDepth: depth, sum: depth, n: 1 };
      else { cur.y1 = r.y; cur.maxDepth = Math.max(cur.maxDepth, depth); cur.sum += depth; cur.n++; }
    } else if (cur !== null) { segs.push(cur); cur = null; }
  });
  if (cur !== null) segs.push(cur);
  return segs.map((s) => ({
    yMid: (s.y0 + s.y1) / 2,
    height: s.y1 - s.y0 + 1,
    depth: s.maxDepth,
    weight: s.sum,
  }));
}

const fmt = (xs) => xs.map((s) => `${s.yMid.toFixed(1)}(${s.kind}${s.height.toFixed(0)}px,d${s.depth.toFixed(0)})`).join(' ');

// ═══ S1: 三条空带 × 3 连拍 ═══
console.log('═══ S1 空带流动（belt 屏幕带逐行扫描，检测指针暗痕）═══');
{
  const c = cam(8, 7);
  const belts = [
    { name: 'belt1(x=5)', xs: 512, xe: 538 },
    { name: 'belt2(x=8)', xs: 627, xe: 653 },
    { name: 'belt3(x=11)', xs: 742, xe: 768 },
  ];
  // 带屏幕纵向范围: cells y=5..9 → world 320..640 → screenY
  const yTop = Math.round(screenY(320, c)), yBot = Math.round(screenY(640, c));
  const all = [];
  for (let s = 1; s <= 3; s++) {
    const img = await loadRaw(`log/t29c-s1-${s}.png`);
    const shotRes = [];
    for (const b of belts) {
      const rows = rowProfile(img, b.xs, b.xe, yTop, yBot);
      // 指针暗痕浅（阈值低）；空带上只有指针
      const blobs = detectBlobs(rows, 6).map((s2) => ({ ...s2, kind: 'ptr' }));
      shotRes.push(blobs);
      console.log(`  s1-${s} ${b.name}: ${blobs.length} 支指针 @ ${fmt(blobs)}`);
    }
    all.push(shotRes);
  }
  // 连拍位移: 同带相邻两拍，指针应整体上移 0.25 格 = 9.6px（循环端部允许出入带）
  console.log('  连拍位移核验（期望每支 ≈ −9.6px 上移，端部滑出/滑入豁免）:');
  let moved = 0, frozen = 0, total = 0;
  for (let b = 0; b < 3; b++) {
    for (let s = 0; s < 2; s++) {
      const A = all[s][b], B = all[s + 1][b];
      for (const bb of B) {
        // 匹配 A 中最近的（含 ±1 格循环）——端部: A 中最接近带顶的指针可能滑出，B 中带底多一支滑入
        let best = null, bestD = Infinity;
        for (const aa of A) {
          for (const wrap of [0, -CELL_PX]) {
            const d = (aa.yMid + wrap) - bb.yMid;
            if (Math.abs(d) < Math.abs(bestD)) { bestD = d; best = aa; }
          }
        }
        total++;
        if (best === null || Math.abs(bestD) > 4.8) { frozen++; console.log(`    ⚠ ${belts[b].name} s${s + 1}→s${s + 2} 指针 @${bb.yMid.toFixed(1)} 无匹配位移（最近 Δ=${best ? bestD.toFixed(1) : 'n/a'}）`); }
        else moved++;
      }
    }
  }
  console.log(`  匹配位移 ${moved}/${total} 支次，未匹配/静止 ${frozen}`);
  // 相位差: 同一拍三带指针位置 mod 格宽的相位
  console.log('  相位核验（各带指针相位 mod 1 格，三带应明显不同）:');
  for (let s = 0; s < 3; s++) {
    const phases = all[s].map((blobs) => {
      const fr = blobs.map((bb) => ((bb.yMid - yTop) / CELL_PX) % 1);
      return fr.map((v) => v.toFixed(2)).join(',');
    });
    console.log(`    s1-${s + 1}: belt1[${phases[0]}] belt2[${phases[1]}] belt3[${phases[2]}]`);
  }
}

// ═══ S2: 取货口 8 格带 × 15 连拍 ═══
console.log('\n═══ S2 取货口前导空格（物品=大暗斑 / 指针=浅痕，逐格占用）═══');
{
  const c = cam(5, 6);
  // belt x=5 → 屏幕 x 带
  const xs = Math.round(screenX(5 * 64, c)) + 6, xe = Math.round(screenX(6 * 64, c)) - 6;
  // cells y=2..9 → world y = 2*64 .. 10*64
  const yTop = Math.round(screenY(2 * 64, c)), yBot = Math.round(screenY(10 * 64, c));
  const cellTop = yTop; // cell (5,2) 顶
  console.log(`  扫描带 x∈[${xs},${xe}) y∈[${yTop},${yBot})（cell 高 ${CELL_PX}px）`);
  let leadingGapShots = 0;
  for (let s = 1; s <= 15; s++) {
    const img = await loadRaw(`log/t29c-s2-${String(s).padStart(2, '0')}.png`);
    const rows = rowProfile(img, xs, xe, yTop, yBot);
    const blobs = detectBlobs(rows, 8).map((b) => ({
      ...b,
      kind: b.height >= 14 ? 'ITEM' : 'ptr',
    }));
    // 每格占用: cellIdx 0=(5,2) 顶格 … 7=(5,9) 底格。物品沿 direction 270 向上走:
    // 链首=(5,9) 底格（注入），链尾=(5,2) 顶格（死端）。领头物品 = y 最小（最上方）。
    const cells = new Array(8).fill('.');
    for (const b of blobs) {
      const idx = Math.floor((b.yMid - cellTop) / CELL_PX);
      if (idx >= 0 && idx < 8) {
        if (cells[idx] === '.' || b.kind === 'ITEM') cells[idx] = b.kind === 'ITEM' ? 'I' : 'A';
      }
    }
    const layout = cells.join('');
    // 领头物品 = 最上方 I；其上方一格（更靠链尾）若在链内必须有 I 或 A（IIAAAAAA）
    const leadIdx = cells.indexOf('I');
    let gapAt = -1;
    if (leadIdx > 0) {
      if (cells[leadIdx - 1] === '.') gapAt = leadIdx - 1;
    }
    if (gapAt >= 0) leadingGapShots++;
    // 注入闪变检查: 孤指针（A 后无任何 I 在其下）且下一拍同格变 I —— 粗查: 孤立 A 在最上方（前面无 I）
    const topEnt = cells.findIndex((ch) => ch !== '.');
    const loneArrowTop = topEnt >= 0 && cells[topEnt] === 'A' && !cells.slice(topEnt).includes('I');
    console.log(`  s2-${String(s).padStart(2, '0')}: [${layout}]（上=链尾(5,2) ← 下=链首(5,9)）${gapAt >= 0 ? `❌前导空格@格${gapAt}` : '✅无前导空格'}${loneArrowTop ? ' ⚠顶格孤指针' : ''} blobs=${blobs.length}`);
  }
  console.log(`  前导空格出现于 ${leadingGapShots}/15 张`);
}

// ═══ S3: 满载 6 格带 × 3 张 ═══
console.log('\n═══ S3 满载无下骑（密集物品流，检测物品间隙是否藏指针）═══');
{
  const c = cam(5, 8);
  const xs = Math.round(screenX(5 * 64, c)) + 6, xe = Math.round(screenX(6 * 64, c)) - 6;
  const yTop = Math.round(screenY(6 * 64, c)), yBot = Math.round(screenY(12 * 64, c));
  for (let s = 1; s <= 3; s++) {
    const img = await loadRaw(`log/t29c-s3-${s}.png`);
    const rows = rowProfile(img, xs, xe, yTop, yBot);
    const blobs = detectBlobs(rows, 8).map((b) => ({ ...b, kind: b.height >= 14 ? 'ITEM' : 'ptr' }));
    const items = blobs.filter((b) => b.kind === 'ITEM');
    const ptrs = blobs.filter((b) => b.kind === 'ptr');
    // 指针若存在于物品间隙: ptr 中心与最近 ITEM 中心距离 ≥ 半格（物品间隙中可见）
    const freePtrs = ptrs.filter((p) => items.every((it) => Math.abs(it.yMid - p.yMid) > CELL_PX * 0.45));
    const cells = new Array(6).fill('.');
    for (const b of blobs) {
      const idx = Math.floor((b.yMid - yTop) / CELL_PX);
      if (idx >= 0 && idx < 6) if (cells[idx] === '.' || b.kind === 'ITEM') cells[idx] = b.kind === 'ITEM' ? 'I' : 'A';
    }
    console.log(`  s3-${s}: [${cells.join('')}]（上=链尾(5,6) ← 下=链首(5,11)）物品 ${items.length} 件，指针痕 ${ptrs.length} 个${freePtrs.length ? `，❌间隙可见指针 ${freePtrs.length} @ ${fmt(freePtrs)}` : '，物品流下方无独立指针（下骑=0）'}`);
  }
}
console.log('\n扫描完成。');
