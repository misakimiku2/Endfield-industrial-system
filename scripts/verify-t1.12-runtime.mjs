// T1.12 运行时像素探针 — 验证掩码→烘焙→渲染链路（确定性，非目测）
// 前置: vite dev server (localhost:5173) + Chrome --remote-debugging-port=9222
// 运行: node scripts/verify-t1.12-runtime.mjs
//
// 原理: 放置 demo 设备后，对已知世界坐标探针点经 camera.worldToScreen 换算屏幕
// 坐标，用 Page.captureScreenshot(clip 8×8) 截取并解码中心像素，断言颜色类别:
//   PANEL #cbc9c9(203) 固体口面板 / DISC #d2d2d2(210) 液体盘身 /
//   BOARD #202020(32) 底板 / BG #e6e4e4(230) 页面背景（空心格透出）
// 离线拼装已由 verify-t1.12-portvariant.mjs 像素级验证；本脚本验证的是
// 运行时掩码派生 → 纹理选择 → 烘焙 → 屏幕落位全链路。
const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name} ${extra}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.pending = new Map();
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}

// 颜色类别判定（zoom=2 下 2×2 混叠，容差放宽）
const near = (p, hex, tol = 26) => Math.abs(p[0] - hex[0]) <= tol && Math.abs(p[1] - hex[1]) <= tol && Math.abs(p[2] - hex[2]) <= tol;
const isPanel = p => near(p, [203, 201, 201]);   // #cbc9c9 固体口面板 / deco 饰条
const isPortLight = p => isPanel(p) || near(p, [224, 222, 222]); // 面板双色（mid #cbc9c9 / top 窄条 #e0dede）
const isDisc = p => near(p, [210, 210, 210]);    // #d2d2d2 液体盘身
const isBoard = p => near(p, [32, 32, 32], 30);  // #202020 端口底板
const isEmblazon = p => near(p, [130, 128, 128], 26); // #828080 emblazon 小方块
const isBg = p => near(p, [230, 228, 228], 26);  // #e6e4e4 页面背景（空心）
const rgb = p => `rgb(${p.join(',')})`;

const { default: sharp } = await import('sharp');

/** 探针: 相机对中到世界坐标点（该点必然落在屏幕中心），截屏中心 8×8 解码。
 *  @param zoom 探针用缩放（默认与场景一致的 2；细缝目标用 4 放大抗采样误差） */
async function probePixel(cdp, worldX, worldY, zoom = 2) {
  await evalJs(cdp, `__game.camera.x = ${worldX}; __game.camera.y = ${worldY}; __game.camera.setZoom(${zoom}); true;`);
  await sleep(150); // 等一帧渲染
  const [vw, vh] = await evalJs(cdp, `(() => {
    const v = __game.camera.getViewport();
    return [Math.round(v.width / 2), Math.round(v.height / 2)];
  })()`);
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: vw - 4, y: vh - 4, width: 8, height: 8, scale: 1 },
  });
  const buf = Buffer.from(data, 'base64');
  const { data: raw } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (4 * 4) * 8 + 4 * 4; // 中心像素
  return [raw[i], raw[i + 1], raw[i + 2]];
}

async function main() {
  const list = await (await fetch(`${CDP}/json`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.startsWith(APP));
  const cdp = new CDPClient(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  check('0. 放置场景', await evalJs(cdp, `(() => {
    __game.clearAllPlaced();
    const r = [
      __game.placeAt('refining_unit', 5, 3),
      __game.placeAt('test_nineslice_noport', 10, 3),
      __game.placeAt('test_nineslice_4x3', 14, 3),
      __game.placeAt('test_nineslice_liquid_5x5', 5, 8),
      __game.placeAt('test_nineslice_6x6', 12, 8),
      __game.placeAt('test_nineslice_noport', 2, 8, 90),
      __game.placeAt('test_nineslice_full_5x5', 19, 8),
    ];
    __game.camera.setZoom(2);
    __game.gridRenderer.visible = false;
    return r.every(Boolean);
  })()`));
  await sleep(500);

  // ── 1. 精炼炉: 外观与现状一致（固体全掩码 + emblazon + 左右液口） ──
  {
    const top = await probePixel(cdp, 5 * 64 + 96, 3 * 64 + 24);
    check('精炼炉 顶行中列固体口面板', isPortLight(top), rgb(top));
    const bot = await probePixel(cdp, 5 * 64 + 96, 3 * 64 + 162);
    check('精炼炉 底行中列固体口面板', isPortLight(bot), rgb(bot));
    const ld = await probePixel(cdp, 5 * 64 + 20, 3 * 64 + 96);
    check('精炼炉 左侧液口盘身', isDisc(ld), rgb(ld));
    const rd = await probePixel(cdp, 5 * 64 + 192 - 20, 3 * 64 + 96);
    check('精炼炉 右侧液口盘身', isDisc(rd), rgb(rd));
    // emblazon: 全口相邻 → 边界0(A)/边界1(B) 各一颗（2026-08-21 语义）
    const et = await probePixel(cdp, 5 * 64 + 65, 3 * 64 + 29);
    const eb = await probePixel(cdp, 5 * 64 + 65, 3 * 64 + 163);
    check('精炼炉 相邻口边界 emblazon（顶/底）', isEmblazon(et) && isEmblazon(eb), `${rgb(et)} / ${rgb(eb)}`);
  }

  // ── 2. 无端口 3×3: 顶/底镂空 + 两侧 deco + 无 emblazon ──
  {
    const top = await probePixel(cdp, 10 * 64 + 96, 3 * 64 + 24);
    check('无端口 顶行镂空（无底板无面板）', isBg(top), rgb(top));
    const bot = await probePixel(cdp, 10 * 64 + 96, 3 * 64 + 168);
    check('无端口 底行镂空（无底板无面板）', isBg(bot), rgb(bot));
    const dl = await probePixel(cdp, 10 * 64 + 16, 3 * 64 + 96);
    const dr = await probePixel(cdp, 10 * 64 + 192 - 16, 3 * 64 + 96);
    check('无端口 左右 deco 装饰条', isPanel(dl) && isPanel(dr), `${rgb(dl)} / ${rgb(dr)}`);
    const et = await probePixel(cdp, 10 * 64 + 65, 3 * 64 + 29);
    check('无端口 无 emblazon', isBg(et), rgb(et));
  }

  // ── 3. 部分端口 4×3: 仅命中格有口（顶 dx=2 / 底 dx=1）──
  {
    const t2 = await probePixel(cdp, 14 * 64 + 2 * 64 + 32, 3 * 64 + 24);
    const t0 = await probePixel(cdp, 14 * 64 + 32, 3 * 64 + 24);
    check('部分端口 顶行 dx=2 有面板', isPanel(t2), rgb(t2));
    check('部分端口 顶行 dx=0 镂空（无底板）', isBg(t0), rgb(t0));
    // 底板只露 ~1.5px 黑边（面板几乎全盖）——zoom4 探面板下缘横缝 y=+45（面板底 44.3 / 底板底 45.9）。
    // 缝窄 + DPR 采样偏移会读到黑边与背景的 AA 混合 → 判定取"深色"（<120，区别于
    // 背景 230 / 面板 203 / emblazon 130）
    const t2board = await probePixel(cdp, 14 * 64 + 2 * 64 + 32, 3 * 64 + 45, 4);
    check('部分端口 顶行 dx=2 有端口底板（跟端口走）', t2board[0] < 120, rgb(t2board));
    const b1 = await probePixel(cdp, 14 * 64 + 64 + 32, 3 * 64 + 162);
    const b0 = await probePixel(cdp, 14 * 64 + 32, 3 * 64 + 162);
    check('部分端口 底行 dx=1 有面板', isPortLight(b1), rgb(b1));
    check('部分端口 底行 dx=0 镂空（无底板）', isBg(b0), rgb(b0));
    // emblazon（OR 语义，三轮修订）: 单口非角格 → 两侧各一颗；两侧无口的边界没有
    const etL = await probePixel(cdp, 896 + 128 + 1, 3 * 64 + 29);   // 顶口(col2)左边界
    const etR = await probePixel(cdp, 896 + 192 + 1, 3 * 64 + 29);   // 顶口右边界
    const etN = await probePixel(cdp, 896 + 64 + 1, 3 * 64 + 29);    // 边界0 两侧无口
    const ebL = await probePixel(cdp, 896 + 64 + 1, 3 * 64 + 163);   // 底口(col1)左边界
    const ebR = await probePixel(cdp, 896 + 128 + 1, 3 * 64 + 163);  // 底口右边界
    check('部分端口 顶口(col2)两侧各一颗 emblazon', isEmblazon(etL) && isEmblazon(etR), `${rgb(etL)} / ${rgb(etR)}`);
    check('部分端口 底口(col1)两侧各一颗 emblazon', isEmblazon(ebL) && isEmblazon(ebR), `${rgb(ebL)} / ${rgb(ebR)}`);
    check('部分端口 两侧无口的边界无 emblazon', isBg(etN), rgb(etN));
  }

  // ── 4. 侧液口 5×5: 左 dy=1,3 两盘 + 右 dy=2 一盘；有液口侧无 deco ──
  {
    const l1 = await probePixel(cdp, 5 * 64 + 20, 8 * 64 + 64 + 32);
    const l3 = await probePixel(cdp, 5 * 64 + 20, 8 * 64 + 3 * 64 + 32);
    const l2 = await probePixel(cdp, 5 * 64 + 16, 8 * 64 + 2 * 64 + 32);
    check('侧液口 左 dy=1 盘身', isDisc(l1), rgb(l1));
    check('侧液口 左 dy=3 盘身', isDisc(l3), rgb(l3));
    check('侧液口 左 dy=2 无口且无 deco（空心透背景）', isBg(l2), rgb(l2));
    const r2 = await probePixel(cdp, 5 * 64 + 320 - 20, 8 * 64 + 2 * 64 + 32);
    check('侧液口 右 dy=2 盘身', isDisc(r2), rgb(r2));
    const r1 = await probePixel(cdp, 5 * 64 + 320 - 16, 8 * 64 + 64 + 32);
    check('侧液口 右 dy=1 无口且无 deco', isBg(r1), rgb(r1));
  }

  // ── 5. 6×6 deco 连续饰条（行边界处不断裂） ──
  {
    const mid = await probePixel(cdp, 12 * 64 + 16, 8 * 64 + 2 * 64); // 行 1/2 边界 y=+128
    const rows = await probePixel(cdp, 12 * 64 + 16, 8 * 64 + 3 * 64 + 32);
    check('6×6 deco 行边界连续（y=行缝处仍 #cbc9c9）', isPanel(mid), rgb(mid));
    check('6×6 deco 中段', isPanel(rows), rgb(rows));
  }

  // ── 6. 旋转 90° 无端口设备: deco 随容器转到上/下边 ──
  {
    const top = await probePixel(cdp, 2 * 64 + 96, 8 * 64 + 16);
    const bot = await probePixel(cdp, 2 * 64 + 96, 8 * 64 + 176);
    check('旋转 90° deco 转到上边', isPanel(top), rgb(top));
    check('旋转 90° deco 转到下边', isPanel(bot), rgb(bot));
  }

  // ── 7. 满口 5×5: 整行固体口 + 每边界 emblazon + 两侧 deco 同屏 ──
  {
    const L = 19 * 64, T = 8 * 64; // 左上 (1216, 512)
    const b1 = await probePixel(cdp, L + 64 + 1, T + 29);
    const b2 = await probePixel(cdp, L + 128 + 1, T + 29);
    const b3 = await probePixel(cdp, L + 192 + 1, T + 29);
    const b4 = await probePixel(cdp, L + 256 + 1, T + 29);
    check('满口5×5 顶行 4 条边界全有 emblazon', isEmblazon(b1) && isEmblazon(b2) && isEmblazon(b3) && isEmblazon(b4),
      `${rgb(b1)} ${rgb(b2)} ${rgb(b3)} ${rgb(b4)}`);
    const bb = await probePixel(cdp, L + 128 + 1, T + 4 * 64 + 29);
    check('满口5×5 底行边界 emblazon', isEmblazon(bb), rgb(bb));
    const dl = await probePixel(cdp, L + 16, T + 96);
    const dr = await probePixel(cdp, L + 320 - 16, T + 96);
    const dmid = await probePixel(cdp, L + 16, T + 128); // 行 1/2 缝
    check('满口5×5 无液口 → 两侧 deco 连续饰条', isPanel(dl) && isPanel(dr) && isPanel(dmid),
      `${rgb(dl)} / ${rgb(dr)} / ${rgb(dmid)}`);
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
