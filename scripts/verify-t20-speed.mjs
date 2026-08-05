// 指针速度验证: 500ms 间隔截 2 帧,对比箭头位移(每格 2 秒 → 500ms 移动 1/4 格)
import { writeFileSync } from 'node:fs';
const CDP = 'http://localhost:9222';
const APP = 'http://localhost:5173';
const OUT = 'C:/Users/Misaki/.workbuddy/tmp/t20-shots';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.ready = new Promise((res) => { this.ws.addEventListener('open', res); });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}
async function evalJs(cdp, e) {
  const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
}
async function pointerPositions(cdp) {
  return evalJs(cdp, `(() => {
    const g = window.__game;
    const wc = g.app.stage.children.find(c => c.label === 'worldContainer');
    const l3 = wc ? wc.children.find(c => c.label === 'item') : null;
    const sprites = l3 ? l3.children : [];
    return JSON.stringify(sprites.map(s => ({ x: Math.round(s.x), y: Math.round(s.y) })));
  })()`);
}

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.belt)`).catch(() => false);
}
await evalJs(cdp, `(() => { const c=window.__game.camera; c.setPosition(700,300); c.updateTransform?.(); })()`);
await evalJs(cdp, `window.__game.clearAllPlaced?.()`);
await evalJs(cdp, `window.__game.clearTestDevices?.()`);
await delay(300);
await evalJs(cdp, `window.__game.placeAt('refining_unit',8,8)`);
await delay(500);

// 创建 L 形链 (9,8)→(9,4)→(13,4): 10 段
const port = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 8*64+32)`);
await evalJs(cdp, `window.__game.belt.enterMode()`);
await evalJs(cdp, `window.__game.belt.setMouse(${port.x}, ${port.y}, true)`);
await evalJs(cdp, `window.__game.belt.onPointerDown(${port.x}, ${port.y}, 0)`);
const wp1 = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 4*64+32)`);
await evalJs(cdp, `window.__game.belt.setMouse(${wp1.x}, ${wp1.y}, true)`);
await delay(200);
await evalJs(cdp, `window.__game.belt.addWaypoint()`);
await delay(200);
const wp2 = await evalJs(cdp, `window.__game.camera.worldToScreen(13*64+32, 4*64+32)`);
await evalJs(cdp, `window.__game.belt.setMouse(${wp2.x}, ${wp2.y}, true)`);
await delay(200);
await evalJs(cdp, `window.__game.belt.addWaypoint()`);
await delay(200);
await evalJs(cdp, `window.__game.belt.onPointerDown(${wp2.x}, ${wp2.y}, 2)`);
await delay(400);

console.log('t0 箭头位置:', await pointerPositions(cdp));
await shot(cdp, 'speed_t0');
await delay(1000); // 1 秒 = 半格
console.log('t1(+1s) 箭头位置:', await pointerPositions(cdp));
await shot(cdp, 'speed_t1');
await delay(1000); // 再 1 秒 = 又半格
console.log('t2(+2s) 箭头位置:', await pointerPositions(cdp));
await shot(cdp, 'speed_t2');

console.log('DONE');
process.exit(0);