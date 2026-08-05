// 修复验证 — Bug#1 右键落盘 / Bug#2 占用格红块 / 回归
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
console.log('ready:', ready);
await evalJs(cdp, `(() => { const c=window.__game.camera; c.setPosition(700,700); c.updateTransform?.(); })()`);
await evalJs(cdp, `window.__game.clearAllPlaced?.()`);
await evalJs(cdp, `window.__game.clearTestDevices?.()`);
await delay(300);
await evalJs(cdp, `window.__game.placeAt('refining_unit',8,8)`);
await delay(500);

const port = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 8*64+32)`);
const tgt = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 3*64+32)`);
const tgtL = await evalJs(cdp, `window.__game.camera.worldToScreen(12*64+32, 3*64+32)`);
const occ = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 9*64+32)`);
const port2 = await evalJs(cdp, `window.__game.camera.worldToScreen(8*64+32, 8*64+32)`);

// ── Bug#1 验证: 点端口 → setMouse 目标 → 右键 → 落盘+退出 ──
await keyPress(cdp, 'KeyE', 'e', 69);
await setMouseTo(cdp, port.x, port.y);
await delay(150);
await mouseClick(cdp, port.x, port.y, 'left');
console.log('1. click port →', await evalJs(cdp, `window.__game.belt.getMode()`));
await setMouseTo(cdp, tgt.x, tgt.y);
await delay(300);
console.log('2. preview:', await evalJs(cdp, `JSON.stringify({valid:window.__game.belt.previewValid, n:window.__game.belt.previewPath.length, children:window.__game.belt.previewContainer.children.length})`));
await shot(cdp, 'fix1_preview_blue');
// 模拟右键(绕过 CDP right 事件限制, 直接调 onPointerDown)
await evalJs(cdp, `window.__game.belt.onPointerDown(${tgt.x}, ${tgt.y}, 2)`);
await delay(400);
console.log('3. after right → mode:', await evalJs(cdp, `window.__game.belt.getMode()`), 'segments:', await evalJs(cdp, `window.__game.world.query('Position','BeltSegmentComp').length`));
await shot(cdp, 'fix1_placed_yellow');

// ── Bug#2 验证: 新起点(8,8)端口 → setMouse 到精炼炉内部(9,9) → 红块 ──
await keyPress(cdp, 'KeyE', 'e', 69); // 进入(hover)
await setMouseTo(cdp, port2.x, port2.y);
await delay(150);
await mouseClick(cdp, port2.x, port2.y, 'left'); // preview
console.log('4. occupied mode:', await evalJs(cdp, `window.__game.belt.getMode()`));
await setMouseTo(cdp, occ.x, occ.y);
await delay(400);
console.log('5. occupied diag:', await evalJs(cdp, `JSON.stringify({valid:window.__game.belt.previewValid, path:window.__game.belt.previewPath.length, children:window.__game.belt.previewContainer.children.length, visible:window.__game.belt.previewContainer.visible, mode:window.__game.belt.getMode()})`));
await shot(cdp, 'fix2_occupied_red');
// 移回空地 (13,8) → 应恢复蓝色预览
const free = await evalJs(cdp, `window.__game.camera.worldToScreen(13*64+32, 8*64+32)`);
await setMouseTo(cdp, free.x, free.y);
await delay(400);
console.log('6. back to free:', await evalJs(cdp, `JSON.stringify({valid:window.__game.belt.previewValid, path:window.__game.belt.previewPath.length, children:window.__game.belt.previewContainer.children.length})`));
await shot(cdp, 'fix2_back_blue');
// 右键退出(不落盘)
await evalJs(cdp, `window.__game.belt.onPointerDown(${free.x}, ${free.y}, 2)`);
await delay(300);
console.log('7. after right exit → mode:', await evalJs(cdp, `window.__game.belt.getMode()`));

// ── 回归: L 形预览 + 落盘 ──
await keyPress(cdp, 'KeyE', 'e', 69);
await setMouseTo(cdp, port.x, port.y);
await delay(150);
await mouseClick(cdp, port.x, port.y, 'left');
await setMouseTo(cdp, tgtL.x, tgtL.y);
await delay(400);
console.log('8. L-shape:', await evalJs(cdp, `JSON.stringify({valid:window.__game.belt.previewValid, path:window.__game.belt.previewPath.length, children:window.__game.belt.previewContainer.children.length})`));
await shot(cdp, 'fix3_lshape');
await evalJs(cdp, `window.__game.belt.onPointerDown(${tgtL.x}, ${tgtL.y}, 2)`);
await delay(400);
console.log('9. L placed → segments:', await evalJs(cdp, `window.__game.world.query('Position','BeltSegmentComp').length`), 'mode:', await evalJs(cdp, `window.__game.belt.getMode()`));
await shot(cdp, 'fix3_lshape_placed');

console.log('DONE');
process.exit(0);