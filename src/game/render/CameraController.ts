// 相机输入控制器 — 把 DOM 事件翻译成 Camera 操作
// 依据: implementation-phase-1.md T1.2（中键拖拽、WASD、滚轮以鼠标为中心缩放）
//                            T1.5（边缘滚动、Ctrl+R 视图旋转、WASD 改屏幕相对）
//       A6 coordinate-spec.md §4（相机操作）、§4.0（viewRotation 参考系约定）
//
// 职责: 监听 canvas/window 上的鼠标与键盘事件，调用 Camera 的平移/缩放/旋转方法。
// 相机自身的边界约束、坐标转换由 Camera 负责；Controller 只负责事件归一化。
//
// 拖拽平移: 按住中键移动 → 相机反向跟随（拖地球向右，看到的画面向左移）。
//   屏幕位移直接按 screenDelta 反算（拖拽天然屏幕相对，不受视图旋转影响）。
// WASD: 屏幕相对平移。按帧速 * CAMERA_KEY_PAN_SPEED，再用 screenDirToWorld
//   把屏幕方向映射到世界方向（视图旋转后按 W 永远让画面向屏幕上方移）。
// 边缘滚动: 鼠标在窗口边缘触发带内 → 按屏幕方向滚动，同样经 screenDirToWorld 映射。
// 滚轮: 以鼠标位置为锚点缩放， deltaY > 0（向下滚）缩小， < 0 放大。不受旋转影响。
// Ctrl+R: 视图顺时针旋转 90°（4 态循环），调 camera.rotateClockwise()。

import { Camera } from './Camera';
import {
  CAMERA_ZOOM_WHEEL_STEP,
  CAMERA_KEY_PAN_SPEED,
  CAMERA_EDGE_SCROLL_MARGIN,
  CAMERA_EDGE_SCROLL_SPEED,
} from './constants';

export class CameraController {
  private camera: Camera;
  private canvas: HTMLCanvasElement;

  /** 当前按下的 WASD（用于连续平移）。 */
  private keys = {
    up: false,
    down: false,
    left: false,
    right: false,
  };

  /** 中键拖拽状态。 */
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  /** 鼠标当前屏幕坐标（canvas 内相对坐标，用于滚轮锚点 + 边缘滚动判定）。 */
  private mouseX = 0;
  private mouseY = 0;
  /** 鼠标是否当前在 canvas 内（离开窗口时禁用边缘滚动，防止误触发）。 */
  private mouseInside = false;

  // 持有解绑函数，destroy 时一次性移除所有监听。
  private disposers: Array<() => void> = [];

  constructor(camera: Camera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.canvas = canvas;
    this.attach();
  }

  private attach(): void {
    // 阻止中键默认的"自动滚动"行为
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('auxclick', this.onAuxClick);
    // mouseenter/leave 追踪鼠标是否在 canvas 内（边缘滚动的触发前提）
    this.canvas.addEventListener('mouseenter', this.onMouseEnter);
    this.canvas.addEventListener('mouseleave', this.onMouseLeave);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.disposers.push(() => {
      this.canvas.removeEventListener('mousedown', this.onMouseDown);
      this.canvas.removeEventListener('auxclick', this.onAuxClick);
      this.canvas.removeEventListener('mouseenter', this.onMouseEnter);
      this.canvas.removeEventListener('mouseleave', this.onMouseLeave);
      window.removeEventListener('mousemove', this.onMouseMove);
      window.removeEventListener('mouseup', this.onMouseUp);
      this.canvas.removeEventListener('wheel', this.onWheel);
      this.canvas.removeEventListener('contextmenu', this.onContextMenu);
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onBlur);
    });
  }

  destroy(): void {
    this.disposers.forEach(d => d());
    this.disposers = [];
  }

  // ───────────────────────── 鼠标 ─────────────────────────

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) {
      // 中键：开始拖拽
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      e.preventDefault();
    }
    this.mouseInside = true;
    this.mouseX = e.clientX - this.canvasRectLeft();
    this.mouseY = e.clientY - this.canvasRectTop();
  };

  private onAuxClick = (e: MouseEvent): void => {
    // 中键的 auxclick 在某些浏览器会触发自动滚动，阻止默认
    if (e.button === 1) e.preventDefault();
  };

  private onMouseEnter = (): void => {
    this.mouseInside = true;
  };

  private onMouseLeave = (): void => {
    this.mouseInside = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    const x = e.clientX - this.canvasRectLeft();
    const y = e.clientY - this.canvasRectTop();
    this.mouseX = x;
    this.mouseY = y;

    // mouseInside 主要由 mouseenter/leave 维护；此处补一刀容差判定：
    // 鼠标精确贴到屏幕最右/下缘时，clientX 可能略微超出 clientWidth（亚像素），
    // 用一个小容差避免这种情况下边缘滚动失效（贴边滚动是高频操作）。
    const tol = 2;
    this.mouseInside =
      x >= -tol && y >= -tol &&
      x <= this.canvas.clientWidth + tol &&
      y <= this.canvas.clientHeight + tol;

    if (this.dragging) {
      const dxScreen = e.clientX - this.lastX;
      const dyScreen = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      // 屏幕拖拽方向 = 相机移动方向的反向（拖地球向右，画面向左）。
      // 用 panByScreen 走屏幕相对映射，使旋转视图下拖拽方向仍直觉一致
      // （鼠标上拖 → 画面下移），与 WASD / 边缘滚动同一套参考系。
      this.camera.panByScreen(-dxScreen / this.camera.zoom, -dyScreen / this.camera.zoom);
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 1) {
      this.dragging = false;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // 标准化 wheel delta： deltaY > 0 表示向下滚 → 缩小
    // newZoom = zoom * (step ^ -sign)，向下滚缩小、向上滚放大
    const dir = e.deltaY > 0 ? -1 : 1;
    // 小幅度滚动（触控板）也至少推进 MIN_STEP，避免无感
    const factor = Math.pow(CAMERA_ZOOM_WHEEL_STEP, dir);
    const newZoom = this.camera.zoom * factor;
    this.camera.zoomAt({ x: this.mouseX, y: this.mouseY }, newZoom);
  };

  private onContextMenu = (e: MouseEvent): void => {
    // 相机阶段禁止右键菜单（后续放置系统会用右键取消）
    e.preventDefault();
  };

  // ───────────────────────── 键盘 ─────────────────────────

  private onKeyDown = (e: KeyboardEvent): void => {
    // Ctrl+R: 视图顺时针旋转 90° (A6 §4.0, T1.5)。
    // 拦截浏览器刷新（preventDefault），且不让 KeyR 进入 WASD 状态机。
    if (e.code === 'KeyR' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.camera.rotateClockwise();
      return;
    }
    this.setKey(e.code, true);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.setKey(e.code, false);
  };

  private setKey(code: string, down: boolean): void {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.up = down;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.keys.down = down;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.keys.left = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.keys.right = down;
        break;
    }
  }

  private onBlur = (): void => {
    // 窗口失焦时清空按键状态，避免"按住 W 切走再回来还在移动"
    this.keys.up = this.keys.down = this.keys.left = this.keys.right = false;
    this.dragging = false;
  };

  // ───────────────────────── 帧更新 ─────────────────────────

  /**
   * 每帧调用：处理 WASD 连续平移 + 边缘滚动。两者都是**屏幕相对**平移，
   * 叠加成一个屏幕方向向量后，统一用 screenDirToWorld 映射到世界方向。
   * @param deltaMS 上一帧到本帧的毫秒数（用于平滑、帧率无关移动）
   */
  update(deltaMS: number): void {
    let screenDx = 0; // 屏幕方向平移量（世界像素/秒 × dt 已乘过）
    let screenDy = 0;

    // ── WASD（屏幕方向：右=+x，下=+y）──
    if (this.keys.up || this.keys.down || this.keys.left || this.keys.right) {
      const dist = (CAMERA_KEY_PAN_SPEED * deltaMS) / 1000;
      if (this.keys.left) screenDx -= dist;
      if (this.keys.right) screenDx += dist;
      if (this.keys.up) screenDy -= dist;
      if (this.keys.down) screenDy += dist;
    }

    // ── 边缘滚动（8 方向：鼠标在边缘触发带内 → 该方向滚动）──
    // 仅当鼠标在 canvas 内才判定，避免鼠标离开游戏窗口时画面持续滚动。
    if (this.mouseInside) {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      const m = CAMERA_EDGE_SCROLL_MARGIN;
      let edgeDx = 0;
      let edgeDy = 0;
      // 左右边缘: mouseX ≤ m → 向左滚；mouseX ≥ w−m → 向右滚。
      // 右/下缘不加 ≤ w 上界——鼠标精确贴屏幕最右/下缘时 clientX 可能略超
      // clientWidth（亚像素），此时仍应触发边缘滚动（贴边是高频操作）。
      if (this.mouseX <= m) edgeDx -= 1;
      else if (this.mouseX >= w - m) edgeDx += 1;
      // 上下边缘（叠加成对角方向）
      if (this.mouseY <= m) edgeDy -= 1;
      else if (this.mouseY >= h - m) edgeDy += 1;

      if (edgeDx !== 0 || edgeDy !== 0) {
        const dist = (CAMERA_EDGE_SCROLL_SPEED * deltaMS) / 1000;
        screenDx += edgeDx * dist;
        screenDy += edgeDy * dist;
      }
    }

    // ── 屏幕方向 → 世界方向（视图旋转下的屏幕相对映射）──
    if (screenDx !== 0 || screenDy !== 0) {
      const world = this.camera.screenDirToWorld(screenDx, screenDy);
      this.camera.panByWorld(world.x, world.y);
    }
  }

  // ───────────────────────── 辅助 ─────────────────────────

  private canvasRectLeft(): number {
    return this.canvas.getBoundingClientRect().left;
  }

  private canvasRectTop(): number {
    return this.canvas.getBoundingClientRect().top;
  }
}
