// 验证 Bug C 不可达完整路径 + pointer 视觉
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
const occ = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 9*64+32)`);
const free = await evalJs(cdp, `window.__game.camera.worldToScreen(13*64+32, 8*64+32)`);

// 落盘一条完整 L 形链 (端口 9,8 → 上 4 格到 9,4 → 右 4 格到 13,4) 用于 pointer 视觉
await keyPress(cdp, 'KeyE', 'e', 69);
await setMouseTo(cdp, port.x, port.y);
await delay(150);
await mouseClick(cdp, port.x, port.y, 'left');
const tgt1 = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 4*64+32)`);
await setMouseTo(cdp, tgt1.x, tgt1.y);
await delay(400);
await evalJs(cdp, `window.__game.belt.addWaypoint()`);
await delay(400);
const tgt2 = await evalJs(cdp, `window.__game.camera.worldToScreen(13*64+32, 4*64+32)`);
await setMouseTo(cdp, tgt2.x, tgt2.y);
await delay(400);
await evalJs(cdp, `window.__game.belt.addWaypoint()`);
await delay(400);
// 右键退出 (不落盘最后一段)
await evalJs(cdp, `window.__game.belt.onPointerDown(${tgt2.x}, ${tgt2.y}, 2)`);
await delay(400);

await shot(cdp, 'pointer_chain');
console.log('pointer 视觉已落盘:', await evalJs(cdp, `window.__game.world.query('Position','BeltSegmentComp').length`), '段');

// 等 1.5s 再截一张,对比 pointer 位置(验证动画)
await delay(1500);
await shot(cdp, 'pointer_chain_t2');

// 再重新进入创建模式,演示 Bug C 不可达完整路径
// 链尾 (13,4) 是 tail,点击 (13,4) 作为延长起点
await keyPress(cdp, 'KeyE', 'e', 69);
const tailPos = await evalJs(cdp, `window.__game.camera.worldToScreen(13*64+32, 4*64+32)`);
await setMouseTo(cdp, tailPos.x, tailPos.y);
await delay(200);
await mouseClick(cdp, tailPos.x, tailPos.y, 'left');
console.log('进入 preview mode:', await evalJs(cdp, `window.__game.belt.getMode()`));

// 移到一个合法空地 → 蓝色完整路径
const tgtBlue = await evalJs(cdp, `window.__game.camera.worldToScreen(15*64+32, 4*64+32)`);
await setMouseTo(cdp, tgtBlue.x, tgtBlue.y);
await delay(400);
const dBlue = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, path:b.previewPath.map(c=>({x:c.x,y:c.y})), n:b.previewPath.length, children:b.previewContainer.children.length, mode:b.getMode(), mouseGrid:b.mouseGrid}); })()`);
console.log('可达 (13,4)→(15,4):', dBlue);
await shot(cdp, 'reachable_blue');

// 现在移到不可达格: 放置设备 (14,3) 占 (14-16 × 3-5),包含 (15,4),使其被占
await evalJs(cdp, `window.__game.placeAt('refining_unit', 14, 3)`);
await delay(400);
// 从 (13,4) tail 延长到 (15,4): 终点被设备占
const tgtUnreach = await evalJs(cdp, `window.__game.camera.worldToScreen(15*64+32, 4*64+32)`);
await setMouseTo(cdp, tgtUnreach.x, tgtUnreach.y);
await delay(400);
const dUnreach = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, path:b.previewPath.map(c=>({x:c.x,y:c.y})), n:b.previewPath.length, children:b.previewContainer.children.length, mode:b.getMode()}); })()`);
console.log('终点被占 (13,4)→(15,4):', dUnreach);
await shot(cdp, 'unreachable_red');

// 真不可达: 目标被四面包围。在 (15,4) 周围 4 个方向都放设备(占 footprint)
// (15,4) 自身被 (14,3) 设备占. 测试目标改成 (5,4) 远离设备区
const tgtFar = await evalJs(cdp, `window.__game.camera.worldToScreen(5*64+32, 4*64+32)`);
await setMouseTo(cdp, tgtFar.x, tgtFar.y);
await delay(400);
const dFar = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, path:b.previewPath.map(c=>({x:c.x,y:c.y})), n:b.previewPath.length, children:b.previewContainer.children.length, mode:b.getMode()}); })()`);
console.log('远距可达 (13,4)→(5,4):', dFar);
await shot(cdp, 'reachable_far');

console.log('DONE');
process.exit(0);