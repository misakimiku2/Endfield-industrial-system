// T1.12 浏览器验收 — 端口变体 demo 设备放置 + 截图
// 前置: vite dev server (localhost:5173) + Chrome --remote-debugging-port=9222
// 运行: node scripts/verify-t1.12-visual.mjs
//
// 场景（S3 §6 验收的浏览器部分）:
//   精炼炉(5,3)          —— 固体全掩码 + 左右液口 = 外观与 T1.11 现状一致（0 变化）
//   无端口 3×3(10,3)     —— 纯底座 + 两侧 deco 装饰条
//   无端口 3×3(2,8) 90°  —— 旋转后 deco/底座随容器转
//   部分端口 4×3(14,3)   —— 仅命中格有固体口（顶 dx=2 / 底 dx=1），其余格无口
//   侧液口 5×5(5,8)      —— 左两行 lport-l + 右一行 lport-r（有液口侧不显 deco）
//   高设备 6×6(12,8)     —— deco 逐行平铺合并为连续饰条（无液体口侧）
// 截图: 全景 + 精炼炉特写 + 侧液口特写 → gui-test-screenshots/t1.12-*.png
const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = 'gui-test-screenshots';

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

async function screenshot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.mkdirSync(OUT, { recursive: true });
  const p = `${OUT}/${name}.png`;
  fs.writeFileSync(p, Buffer.from(data, 'base64'));
  console.log(`  📸 ${p}`);
}

const SCENE = `(() => {
  __game.clearAllPlaced();
  const ok = [
    __game.placeAt('refining_unit', 5, 3),
    __game.placeAt('test_nineslice_noport', 10, 3),
    __game.placeAt('test_nineslice_4x3', 14, 3),
    __game.placeAt('test_nineslice_liquid_5x5', 5, 8),
    __game.placeAt('test_nineslice_6x6', 12, 8),
    __game.placeAt('test_nineslice_noport', 2, 8, 90),
    __game.placeAt('test_nineslice_full_5x5', 19, 8),
  ];
  return ok.every(Boolean);
})()`;

async function main() {
  const list = await (await fetch(`${CDP}/json`)).json();
  let page = list.find((t) => t.type === 'page' && t.url.startsWith(APP));
  const cdp = new CDPClient(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  check('1. 放置 6 台 demo 设备', await evalJs(cdp, SCENE));

  // 相机: 全景居中（集群格 x∈[2,24) y∈[3,14) → 世界中心 ≈ (832, 545)），关网格看外观
  await evalJs(cdp, `
    __game.camera.x = 832; __game.camera.y = 548;
    __game.camera.setZoom(1.15);
    __game.gridRenderer.visible = false;
    true;
  `);
  await sleep(600);
  await screenshot(cdp, 't1.12-overview');

  // 精炼炉特写（与 T1.11 外观对照——固体全掩码 + 左右液口 + logo）
  await evalJs(cdp, `
    __game.camera.x = 5 * 64 + 96; __game.camera.y = 3 * 64 + 96;
    __game.camera.setZoom(2.5);
    true;
  `);
  await sleep(400);
  await screenshot(cdp, 't1.12-refining-0diff');

  // 侧液口 5×5 特写
  await evalJs(cdp, `
    __game.camera.x = 5 * 64 + 160; __game.camera.y = 8 * 64 + 160;
    __game.camera.setZoom(2.2);
    true;
  `);
  await sleep(400);
  await screenshot(cdp, 't1.12-liquid-5x5');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
