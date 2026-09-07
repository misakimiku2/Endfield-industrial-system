// S1 指针相位精确测量 — node scripts/_t29c-s1phase.mjs
// 指针在黄色带身上呈暗橙（tint #DFB615），带身亮黄（G≈R≈250+）。
// 检测: 带身中轴带内 G<215 且 B<110 的像素（指针暗橙特征），按行聚类取中心。
import sharp from 'sharp';

const CELL_PX = 38.4; // zoom 0.6 × 64
const Z = 0.6;

async function loadRaw(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, ch: info.channels };
}

// cam(8,7) zoom 0.6, viewport 1280×800: screen = (world−cam)×Z + (640,400)
const cx = 8.5 * 64, cy = 7.5 * 64;
const beltXCenter = (gx) => ((gx + 0.5) * 64 - cx) * Z + 640;
const worldToY = (wy) => (wy - cy) * Z + 400;
const yTop = Math.round(worldToY(320)); // cell y=5 顶 = 链尾端
const yBot = Math.round(worldToY(640)); // cell y=9 底 = 链首端

function arrowRows(img, xc) {
  const rows = [];
  for (let y = yTop; y < yBot; y++) {
    let n = 0;
    for (let x = xc - 9; x <= xc + 9; x++) {
      const i = (y * img.w + x) * img.ch;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (g < 215 && b < 110 && r > 140) n++; // 暗橙指针像素（排除带身亮黄/背景灰）
    }
    rows.push({ y, n });
  }
  // 聚类（相邻行 n≥2 连续段）
  const segs = [];
  let cur = null;
  for (const { y, n } of rows) {
    if (n >= 2) {
      if (cur === null) cur = { y0: y, y1: y, w: n };
      else { cur.y1 = y; cur.w = Math.max(cur.w, n); }
    } else if (cur !== null) { segs.push(cur); cur = null; }
  }
  if (cur !== null) segs.push(cur);
  return segs.filter((s) => s.y1 - s.y0 >= 3).map((s) => (s.y0 + s.y1) / 2);
}

console.log(`扫描带 y∈[${yTop},${yBot})（带宽方向中轴 ±9px），cell=${CELL_PX}px`);
const belts = [5, 8, 11].map((gx) => ({ gx, xc: Math.round(beltXCenter(gx)) }));
const all = {};
for (const s of [1, 2, 3]) {
  const img = await loadRaw(`log/t29c-s1v2-${s}.png`);
  all[s] = [];
  for (const b of belts) {
    const ys = arrowRows(img, b.xc);
    all[s].push(ys);
    const phases = ys.map((y) => (((y - yTop) / CELL_PX) % 1).toFixed(3)).join(', ');
    console.log(`s1v2-${s} belt(x=${b.gx}): ${ys.length} 支 @ ${ys.map((y) => y.toFixed(1)).join(', ')} | 相位 mod1: [${phases}]`);
  }
  // 位移: 与上一拍同带最近匹配（允许一格循环）
  if (s > 1) {
    for (let b = 0; b < 3; b++) {
      const A = all[s - 1][b], B = all[s][b];
      const ds = B.map((y) => {
        let best = Infinity;
        for (const a of A) for (const w of [0, -CELL_PX]) best = Math.min(best, Math.abs(a + w - y));
        return best;
      });
      console.log(`  s1v2-${s - 1}→s1v2-${s} belt${b + 1} 最近匹配残差: ${ds.map((d) => d.toFixed(1)).join(', ')}（≤2.5px 视为同指针随拍移动）`);
    }
  }
}
// 三带互相位差（同一拍）
console.log('\n三带互相位差（格; 期望创建间隔 3.2s → 0.6 / 0.2 / 0.4 若保持创建相位; 实测:）');
for (const s of [1, 2, 3]) {
  const [a, b, c] = all[s].map((ys) => ys.map((y) => ((y - yTop) / CELL_PX) % 1));
  const diff = (P, Q) => {
    // 两组相位最近配对的最小差
    let best = Infinity;
    for (const p of P) for (const q of Q) {
      let d = Math.abs(p - q); d = Math.min(d, 1 - d); best = Math.min(best, d);
    }
    return best;
  };
  console.log(`s1v2-${s}: |belt1−belt2|=${diff(a, b).toFixed(3)}  |belt1−belt3|=${diff(a, c).toFixed(3)}  |belt2−belt3|=${diff(b, c).toFixed(3)}（0=完全同相）`);
}
