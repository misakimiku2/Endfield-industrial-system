// 链级 pointer 流动验证: 连续截 3 帧对比箭头沿链流动(无跳变)
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
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
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
async function mouseClick(cdp, x, y, button = 'left') {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await delay(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
  await delay(300);
}
async function keyPress(cdp, code, key, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  await delay(400);
}
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
}
const setMouseTo = (cdp, sx, sy) => evalJs(cdp, `window.__game.belt.setMouse(${sx}, ${sy}, true)`);

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.belt)`).catch(() => false);
}
await evalJs(cdp, `(() => { const c=window.__game.camera; c.setPosition(700,700); c.updateTransform?.(); })()`);
await evalJs(cdp, `window.__game.clearAllPlaced?.()`);
await evalJs(cdp, `window.__game.clearTestDevices?.()`);
await delay(300);
await evalJs(cdp, `window.__game.placeAt('refining_unit',8,8)`);
await delay(500);

const port = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 8*64+32)`);

// 创建长链 (9,8)→(9,2)→(14,2)→(14,6) 三段多锚点
await keyPress(cdp, 'KeyE', 'e', 69);
await setMouseTo(cdp, port.x, port.y);
await delay(150);
await mouseClick(cdp, port.x, port.y, 'left');

const wp1 = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 2*64+32)`);
await setMouseTo(cdp, wp1.x, wp1.y);
await delay(300);
await evalJs(cdp, `window.__game.belt.addWaypoint()`);
await delay(300);
const wp2 = await evalJs(cdp, `window.__game.camera.worldToScreen(14*64+32, 2*64+32)`);
await setMouseTo(cdp, wp2.x, wp2.y);
await delay(300);
await evalJs(cdp, `window.__game.belt.addWaypoint()`);
await delay(300);
const wp3 = await evalJs(cdp, `window.__game.camera.worldToScreen(14*64+32, 6*64+32)`);
await setMouseTo(cdp, wp3.x, wp3.y);
await delay(300);
await evalJs(cdp, `window.__game.belt.addWaypoint()`);
await delay(300);
// 右键退出
await evalJs(cdp, `window.__game.belt.onPointerDown(${wp3.x}, ${wp3.y}, 2)`);
await delay(300);

const segs = await evalJs(cdp, `window.__game.world.query('Position','BeltSegmentComp').length`);
console.log('链段数:', segs);
console.log('segmentIndex 检查:', await evalJs(cdp, `(() => { const s = window.__game.world.query('Position','BeltSegmentComp'); const infos = s.map(h => { const c = window.__game.world.getComponent(h,'BeltSegmentComp'); return c.segmentIndex; }); return JSON.stringify(infos.sort((a,b)=>a-b)); })()`));

// 连拍 4 帧(间隔 500ms = 1/4 周期),观察箭头沿链流动
for (let i = 0; i < 4; i++) {
  await delay(500);
  await shot(cdp, `chain_flow_t${i}`);
}
console.log('DONE');
process.exit(0);