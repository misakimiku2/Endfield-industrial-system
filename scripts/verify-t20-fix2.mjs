// 验证三个修复:
// A. 延长 90° 转弯预览(强制 tail 方向首步 + 转角在第二格)
// B. 右键只退出,不落盘
// C. 红色警示(BFS 无路径时单格红块,代码路径已正确)
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

// reload 强制拿最新代码(避免 vite HMR 后旧实例引用)
await cdp.send('Page.reload', { ignoreCache: true });

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
const tgtUp = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 3*64+32)`);
const tgtLshape = await evalJs(cdp, `window.__game.camera.worldToScreen(12*64+32, 3*64+32)`);
const tgtExtend = await evalJs(cdp, `window.__game.camera.worldToScreen(5*64+32, 3*64+32)`); // 从 tail (9,3) 向左
const occ = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 9*64+32)`);

// ── 场景 A: 首次 L 形预览(端口→上→右)看转角接合 ──
await keyPress(cdp, 'KeyE', 'e', 69);
await setMouseTo(cdp, port.x, port.y);
await delay(150);
await mouseClick(cdp, port.x, port.y, 'left');
await setMouseTo(cdp, tgtLshape.x, tgtLshape.y);
await delay(400);
const aDiag = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, path:b.previewPath.map(c=>({x:c.x,y:c.y,d:c.direction})), n:b.previewPath.length, children:b.previewContainer.children.length}); })()`);
console.log('A. 首次L形预览:', aDiag);
await shot(cdp, 'fix2_A_lshape');

// ── 场景 B: 延长 90° 转弯(从 tail 向左)—— 关键验证:startingDirection 强制 tail 方向首步 + 转角在第二格 ──
// 落盘当前预览段(左键 addWaypoint):以 tgtLshape (12,3) 为新锚点
// 实际上当前预览路径从端口(9,8)→(9,3)→(12,3),左键落盘整段,新锚点(12,3)
await evalJs(cdp, `window.__game.belt.addWaypoint()`);
await delay(400);
const afterPlace = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({mode:b.getMode(), segments:window.__game.world.query('Position','BeltSegmentComp').length, anchors:b.anchors, lastSeg:b.previewPath.length}); })()`);
console.log('B0. addWaypoint 后:', afterPlace);
await shot(cdp, 'fix2_B0_after_place');

// 移到左侧 (5,3) — tail (12,3) 方向是右(0),目标左侧需要 180° 掉头(禁止)
// 但我们的修复强制 startingDirection=tail.direction=0(右),所以 BFS 不会向左,可能找不到路
// 改成验证 tail 方向首步: 移到 (12,0) — 向上 3 格,需要先右 0 格(startDirection=0),然后向上 → 不可达
// 正确测试: 移到 (15,3) — 向右 3 格(同向继续,合法)
const tgtSame = await evalJs(cdp, `window.__game.camera.worldToScreen(15*64+32, 3*64+32)`);
await setMouseTo(cdp, tgtSame.x, tgtSame.y);
await delay(400);
const bDiag1 = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, path:b.previewPath.map(c=>({x:c.x,y:c.y,d:c.direction})), n:b.previewPath.length, children:b.previewContainer.children.length, anchor:b.anchors, lastAnchorDirection:b.lastAnchorDirection, startPointDir:b.startPoint?.direction}); })()`);
console.log('B1. 同向延长 (15,3):', bDiag1);
await shot(cdp, 'fix2_B1_extend_same');

// 移到 (12,1) — 向上 2 格,firstStep right 后绕路上 + 左(允许,因为没 180° 跳格)
// 这路径其实合法: firstStep 右→上(90°)→上→左(90°)。所以 valid=true。
// 真正的反向延长测试: (10,3) 在 tail 左侧,firstStep right 后无法绕回
const tgtBack = await evalJs(cdp, `window.__game.camera.worldToScreen(10*64+32, 3*64+32)`);
await setMouseTo(cdp, tgtBack.x, tgtBack.y);
await delay(400);
const bDiag2 = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, n:b.previewPath.length, children:b.previewContainer.children.length}); })()`);
console.log('B2. 180°反向延长 (10,3) - 应无效:', bDiag2);
await shot(cdp, 'fix2_B2_extend_invalid');

// 移到 (15,1) — 向右+向上(顺路,先右然后上合法?动量 L 形)
// startingDirection=0(右),firstStep=右,然后可以向上 → 应该 valid
const tgtLandUp = await evalJs(cdp, `window.__game.camera.worldToScreen(15*64+32, 1*64+32)`);
await setMouseTo(cdp, tgtLandUp.x, tgtLandUp.y);
await delay(400);
const bDiag3 = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, path:b.previewPath.map(c=>({x:c.x,y:c.y,d:c.direction})), n:b.previewPath.length, children:b.previewContainer.children.length}); })()`);
console.log('B3. 右+上延长 (15,1):', bDiag3);
await shot(cdp, 'fix2_B3_extend_landup');

// ── 场景 C: 右键只退出不落盘(修复后行为) ──
const segBefore = await evalJs(cdp, `window.__game.world.query('Position','BeltSegmentComp').length`);
const pathBefore = await evalJs(cdp, `window.__game.belt.previewPath.length`);
// 右键(eval onPointerDown,模拟)
await evalJs(cdp, `window.__game.belt.onPointerDown(${tgtLandUp.x}, ${tgtLandUp.y}, 2)`);
await delay(400);
const segAfter = await evalJs(cdp, `window.__game.world.query('Position','BeltSegmentComp').length`);
const modeAfter = await evalJs(cdp, `window.__game.belt.getMode()`);
console.log(`C. 右键退出: segBefore=${segBefore}, segAfter=${segAfter}, pathBefore=${pathBefore}, mode=${modeAfter}`);
console.log(`   期望: segAfter=segBefore(${segBefore}), mode=idle`);
await shot(cdp, 'fix2_C_after_right');

// ── 场景 D: 红色完整路径(再次创建 + 占用格) ──
await keyPress(cdp, 'KeyE', 'e', 69);
await setMouseTo(cdp, port.x, port.y);
await delay(150);
await mouseClick(cdp, port.x, port.y, 'left');
await setMouseTo(cdp, tgtUp.x, tgtUp.y);
await delay(400);
// 移到占用格 (精炼炉内部)
await setMouseTo(cdp, occ.x, occ.y);
await delay(400);
const dDiag = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({valid:b.previewValid, n:b.previewPath.length, children:b.previewContainer.children.length}); })()`);
console.log('D. 占用格:', dDiag);
await shot(cdp, 'fix2_D_occupied');
// 移回空地看恢复
await setMouseTo(cdp, tgtUp.x, tgtUp.y);
await delay(400);
await shot(cdp, 'fix2_D_back');

// 退出
await keyPress(cdp, 'KeyE', 'e', 69);
await keyPress(cdp, 'KeyE', 'e', 69);

console.log('DONE');
process.exit(0);