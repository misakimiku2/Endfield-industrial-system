// Bug C 复验: 目标被占用时应显示完整红色路径(而非单格红块)
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

// 场景1: 目标 = 精炼炉内部 (9,9), 距端口 1 格
await keyPress(cdp, 'KeyE', 'e', 69);
await setMouseTo(cdp, port.x, port.y);
await delay(150);
await mouseClick(cdp, port.x, port.y, 'left');
const occ1 = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 9*64+32)`);
await setMouseTo(cdp, occ1.x, occ1.y);
await delay(400);
const d1 = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, path:b.previewPath.map(c=>({x:c.x,y:c.y,d:c.direction})), n:b.previewPath.length, children:b.previewContainer.children.length}); })()`);
console.log('场景1 目标(9,9)精炼炉内部:', d1);
await shot(cdp, 'fixC_occupied_near');

// 场景2: 目标 = 精炼炉内部 (10,9), 距端口 2 格(含转角? (9,8)→(9,9)→(10,9) 直下再右)
const occ2 = await evalJs(cdp, `window.__game.camera.worldToScreen(10*64+32, 9*64+32)`);
await setMouseTo(cdp, occ2.x, occ2.y);
await delay(400);
const d2 = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, path:b.previewPath.map(c=>({x:c.x,y:c.y,d:c.direction})), n:b.previewPath.length, children:b.previewContainer.children.length}); })()`);
console.log('场景2 目标(10,9):', d2);
await shot(cdp, 'fixC_occupied_far');

// 场景3: 目标 = 合法空地 (13,8), 应显示完整蓝色路径
const free = await evalJs(cdp, `window.__game.camera.worldToScreen(13*64+32, 8*64+32)`);
await setMouseTo(cdp, free.x, free.y);
await delay(400);
const d3 = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, n:b.previewPath.length, children:b.previewContainer.children.length}); })()`);
console.log('场景3 合法空地(13,8):', d3);
await shot(cdp, 'fixC_free_blue');

// 退出
await keyPress(cdp, 'KeyE', 'e', 69);
await keyPress(cdp, 'KeyE', 'e', 69);
console.log('DONE');
process.exit(0);