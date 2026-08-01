// 相机系统 — 2D 俯视相机的平移、缩放与视图旋转（含旋转过渡动画）
// 依据: A6 coordinate-spec.md (三层坐标转换、Camera、相机约束、§4.0 viewRotation),
//       A2 §8 (世界边界), implementation-phase-1.md T1.5
//
// Camera 是纯逻辑类（不依赖 PixiJS），维护相机中心、缩放、视图旋转，提供
// World↔Screen 转换。视口宽高由外部（PixiJS Application）通过
// setViewport 更新。每帧 updateTransform 把相机变换写到一个 worldContainer
// 上，使世界内容随之平移/缩放/旋转。
//
// 视图旋转 (T1.5, A6 §4.0): viewRotation 是 4 个离散目标态 (0/90/180/270)，
// 旋转以**屏幕中心**为枢轴（等价于相机视线中心不动，世界绕它转）。
// 它是渲染/输入层概念，改变的是世界在屏幕上的呈现方式，不改变世界本身，
// 也不进 ECS Component（A6 §4.0 实现提醒）。
//
// 旋转过渡动画: viewRotation 是"目标态"(离散)，内部用连续的 displayRotation
// (弧度)做实际变换。rotateClockwise 只改目标态，update(dt) 每帧把 displayRotation
// lerp 向目标，使旋转有平滑过渡而非瞬间跳变。所有坐标转换(worldToScreen 等)
// 与 updateTransform 都用 displayRotation，保证过渡期间视觉与点击位置完全一致。
// 动画结束后吸附到精确目标值(避免 lerp 残差累积)。
//
// 边界策略: 让世界边缘正好贴住视口边缘（既不露黑底，也不允许看到世界外）。
// 相机中心被约束在 [halfView, worldSize - halfView]；当世界小于视口时居中。
// viewRotation 不改变相机可看的世界范围，clamp 仍在世界轴对齐边界内进行 (A6 §4.0)。
//
// 世界尺寸来源（A11 WV-003 §4.4）: 不再读全局常量 WORLD_WIDTH/HEIGHT_PX，
// 而是构造时由调用方传入 WorldBounds（来自 MapInstance）。Phase 3a 换成
// Chunk 化后，世界尺寸的访问入口仍是这里传入的 bounds，调用方改即可。

import {
  CELL_SIZE,
  CAMERA_ZOOM_MIN,
  CAMERA_ZOOM_MAX,
  CAMERA_ZOOM_DEFAULT,
  CAMERA_ROTATE_ANIM_MS,
  CAMERA_ZOOM_WHEEL_DELTA_DIVISOR,
  CAMERA_ZOOM_SMOOTH_TAU,
  CAMERA_ZOOM_SNAP_EPSILON,
} from './constants';
import type { Container } from 'pixi.js';

export interface ViewportSize {
  width: number; // 视口宽（屏幕像素 / CSS 像素）
  height: number;
}

/**
 * 世界边界（世界像素）。由 MapInstance 的 widthPx/heightPx 提供 (A11 WV-003 §4.4)。
 * Camera 的初始定位与边界 clamp 都读它，不再读全局常量。
 */
export interface WorldBounds {
  widthPx: number;
  heightPx: number;
}

/** 视图旋转的 4 个离散态 (A6 §4.1)。 */
export type ViewRotation = 0 | 90 | 180 | 270;

export class Camera {
  /** 相机中心的世界 X 坐标（世界像素）。 */
  x: number;
  /** 相机中心的世界 Y 坐标（世界像素）。 */
  y: number;
  /** 缩放倍率 (1.0 = 1 世界像素 = 1 屏幕像素)。 */
  zoom: number;
  /** 视图旋转目标态 (A6 §4.0, T1.5)。0 = 默认朝向，Ctrl+R 顺时针 90° 循环。 */
  viewRotation: ViewRotation = 0;

  private viewport: ViewportSize;
  /** 世界边界（世界像素）。来自 MapInstance，用于初始定位与 clamp (A11 WV-003 §4.4)。 */
  private bounds: WorldBounds;
  /** 相机变换写入目标（PixiJS 世界容器）。update 时同步其 position/scale/rotation。 */
  private worldContainer: Container | null = null;

  // ── 旋转过渡动画 ──
  /** 实际参与坐标变换的旋转角度（弧度）。每帧由 update() lerp 向目标，动画结束后 == 目标弧度。 */
  private _displayRotation = 0;
  /** 动画起始角度（弧度）。rotateClockwise 时记录当前 displayRotation。 */
  private _rotAnimFrom = 0;
  /** 动画目标角度（弧度）。取 viewRotation 对应的弧度，按最短路径(顺时针)递进。 */
  private _rotAnimTo = 0;
  /** 动画已进行时间(ms)。>= _rotAnimDuration 表示动画结束。 */
  private _rotAnimElapsed = Infinity;

  // ── 滚轮缩放（target lerp 模型，移植自旧 Flutter 项目）──
  // 手感: 滚轮按 deltaY 线性比例累乘 targetZoom，显示 zoom 向 targetZoom 指数趋近。
  // 详见 constants.ts 的 CAMERA_ZOOM_* 参数注释。
  /**
   * 滚轮累乘的目标 zoom。zoomByWheel 按 deltaY 更新它（连滚持续累乘），update() 每帧把
   * 显示 zoom 向它趋近。display 与 target 差距小于 SNAP_EPSILON 时吸附结束。
   */
  private _targetZoom = CAMERA_ZOOM_DEFAULT;
  /**
   * 滚轮缩放期间的固定世界锚点（无漂移的关键）。zoomByWheel 触发时用 screenToWorld 求出
   * 并固定，update() 每帧用当前 zoom 反解相机中心，保证该世界点屏幕位置恒定——等价于瞬时
   * zoomAt 的锚点不变性，只是分摊到多帧。动画结束(_zoomAnchor=null)后停止趋近。
   * 连滚时鼠标动了就刷新锚点。
   */
  private _zoomAnchor: { x: number; y: number } | null = null;

  /**
   * @param viewport 视口尺寸（屏幕像素）
   * @param bounds   世界边界（世界像素），来自 MapInstance (A11 WV-003 §4.4)
   */
  constructor(viewport: ViewportSize, bounds: WorldBounds) {
    this.viewport = viewport;
    this.bounds = bounds;
    this.zoom = CAMERA_ZOOM_DEFAULT;
    // 初始中心置于世界中央
    this.x = bounds.widthPx / 2;
    this.y = bounds.heightPx / 2;
  }

  /**
   * 替换世界边界（A11 WV-003 §4.4）。Phase 3a Chunk 化或加载不同尺寸地图时调用。
   * 替换后重新 clamp 相机中心，确保不越新边界。
   */
  setWorldBounds(bounds: WorldBounds): void {
    this.bounds = bounds;
    this.clampPosition();
  }

  /**
   * 每帧驱动旋转过渡动画与缩放平滑过渡（在主循环里、updateTransform 之前调用）。
   * 两个动画独立判断、可同时进行（旋转 + 缩放并行不互扰）。
   * @param deltaMS 上一帧到本帧的毫秒数
   */
  update(deltaMS: number): void {
    // ── 旋转过渡 ──
    if (this._rotAnimElapsed < CAMERA_ROTATE_ANIM_MS) {
      this._rotAnimElapsed = Math.min(this._rotAnimElapsed + deltaMS, CAMERA_ROTATE_ANIM_MS);
      const t = easeInOutCubic(this._rotAnimElapsed / CAMERA_ROTATE_ANIM_MS);
      this._displayRotation = this._rotAnimFrom + (this._rotAnimTo - this._rotAnimFrom) * t;
      if (this._rotAnimElapsed >= CAMERA_ROTATE_ANIM_MS) {
        // 动画结束: 吸附到精确目标，避免 lerp 残差累积导致后续互逆失真
        this._displayRotation = this._rotAnimTo;
      }
    }

    // ── 滚轮缩放 target lerp（显示 zoom 向 targetZoom 指数趋近）──
    if (this._zoomAnchor) {
      // 帧率无关的指数趋近: k = 1 − exp(−dt/TAU)（等效"每帧 lerp k%"但与帧率无关）
      const k = 1 - Math.exp(-(deltaMS / 1000) / CAMERA_ZOOM_SMOOTH_TAU);
      let newZoom = this.zoom + (this._targetZoom - this.zoom) * k;
      newZoom = clamp(newZoom, this.minZoom(), CAMERA_ZOOM_MAX);
      this.applyZoomAtAnchor(newZoom); // 固定锚点反解相机中心（无漂移）
      // 趋近到容差内 → 吸附到精确 target，结束动画
      if (Math.abs(this.zoom - this._targetZoom) < CAMERA_ZOOM_SNAP_EPSILON) {
        this.applyZoomAtAnchor(this._targetZoom);
        this._zoomAnchor = null;
      }
    }
  }

  /** 当前是否正在旋转过渡中（动画未结束）。外部可据此决定是否阻塞某些输入。 */
  get isRotating(): boolean {
    return this._rotAnimElapsed < CAMERA_ROTATE_ANIM_MS;
  }

  /** 当前是否正在缩放（滚轮趋近动画进行中）。与 isRotating 对称，供 HUD/调试用。 */
  get isZooming(): boolean {
    return this._zoomAnchor !== null;
  }

  /** 当前实际视图旋转弧度（连续，含过渡动画）。供 billboard 徽标反向旋转保持屏幕朝上。 */
  get displayRotation(): number {
    return this._displayRotation;
  }

  /** 绑定 PixiJS 世界容器；此后每帧 updateTransform 会同步其变换。 */
  bindWorldContainer(container: Container): void {
    this.worldContainer = container;
  }

  /** 视口尺寸变化（窗口 resize）时调用。变化后重新 clamp 相机中心。 */
  setViewport(size: ViewportSize): void {
    this.viewport = size;
    this.clampPosition();
  }

  /** 当前视口尺寸（只读访问，供 RenderSystem 等做视口剔除）。 */
  getViewport(): ViewportSize {
    return this.viewport;
  }

  /**
   * 动态最小缩放（T1.10 性能基准要求"缩小到全部设备可见"）。
   *
   * 固定下限 CAMERA_ZOOM_MIN=0.25 在 1280×720 视口下只能看到 2880px 高的世界，
   * 64×64 地图（4096px²）无法整图可见。这里取 0.25 与"整图适配缩放"
   * （视口短边 / 世界短边）的较小值: 世界是方形且旋转为 90° 整数倍时，
   * 该缩放保证 0/90/180/270 四个旋转态下整个世界都落在视口内。
   * 视口大于世界时适配缩放 >1，仍回落到 0.25 固定下限。
   */
  private minZoom(): number {
    const fitZoom = Math.min(
      this.viewport.width / this.bounds.widthPx,
      this.viewport.height / this.bounds.heightPx,
    );
    return Math.min(CAMERA_ZOOM_MIN, fitZoom);
  }

  // ───────────────────────── 坐标转换 (A6 §4, §4.0) ─────────────────────────
  //
  // 旋转以**屏幕中心**(=相机中心)为枢轴。displayRotation 是"视图顺时针"角度(弧度):
  //   world → screen: 先转相机中心相对坐标 → 绕中心逆时针旋转(数学正) → ×zoom → +视口中心
  //   即 rad = -displayRotation（视图顺时针 = 内容在屏幕上逆时针呈现）
  // screenToWorld 是严格逆运算: rad = +displayRotation。
  // 用 displayRotation(连续)而非 viewRotation(离散)使旋转过渡期间视觉与输入一致；
  // 动画结束后 displayRotation == viewRotation 对应弧度，离散态行为不变。
  // 这套符号约定已被 verify-t1.5 验证在 4 个旋转态下逐点互逆，且与 PixiJS
  // Container 的 pivot 变换(updateTransform)一致。

  /** 世界像素坐标 → 屏幕像素坐标 (A6 §4, §4.0)。 */
  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const cx = this.viewport.width / 2;
    const cy = this.viewport.height / 2;
    const dx = wx - this.x;
    const dy = wy - this.y;
    const rad = -this._displayRotation;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    return {
      x: rx * this.zoom + cx,
      y: ry * this.zoom + cy,
    };
  }

  /** 屏幕像素坐标 → 世界像素坐标 (A6 §4, §4.0)。worldToScreen 的逆运算。 */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const cx = this.viewport.width / 2;
    const cy = this.viewport.height / 2;
    const dx = (sx - cx) / this.zoom;
    const dy = (sy - cy) / this.zoom;
    const rad = this._displayRotation;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    return { x: rx + this.x, y: ry + this.y };
  }

  // ───────────────────────── 屏幕相对方向映射 (A6 §4.0) ─────────────────────────

  /**
   * 把屏幕方向向量映射到世界坐标系方向（单位向量，不含缩放）。
   * 用于 WASD / 边缘滚动 / 中键拖拽的"屏幕相对"平移：视图转 θ° 后，屏幕"上"在世界
   * 中对应一个旋转后的方向，平移量需沿此方向施加到相机世界坐标。
   *
   * 数学: screenToWorld 的方向部分用 rad = +displayRotation，故屏幕方向 (dx,dy)
   * 映射到世界 (dx*cos−dy*sin, dx*sin+dy*cos)。
   *
   * 例: displayRotation=π/2(90°)时屏幕"上"(0,−1) → 世界 (1,0)，按 W 让相机 X 增加。
   */
  screenDirToWorld(dx: number, dy: number): { x: number; y: number } {
    const rad = this._displayRotation;
    return {
      x: dx * Math.cos(rad) - dy * Math.sin(rad),
      y: dx * Math.sin(rad) + dy * Math.cos(rad),
    };
  }

  // ───────────────────────── 操作 ─────────────────────────

  /**
   * 在世界坐标系中平移相机（正值向右/下）。
   * 传入的已是世界坐标增量。一般场景较少直接用；屏幕相对平移见 panByScreen。
   */
  panByWorld(dx: number, dy: number): void {
    this.setPosition(this.x + dx, this.y + dy);
  }

  /**
   * 屏幕相对平移：传入屏幕像素位移（如鼠标拖拽增量），按当前视图旋转映射到
   * 世界方向后平移相机。与 WASD / 边缘滚动的 screenDirToWorld 同一套映射，
   * 保证中键拖拽在旋转视图下方向直觉一致（鼠标上拖 → 画面下移，不受旋转影响）。
   *
   * 拖拽语义: 屏幕拖拽方向 = 相机移动方向的反向（拖地球向右，画面向左），
   * 调用方需自行取反后传入（见 CameraController）。
   */
  panByScreen(dxScreen: number, dyScreen: number): void {
    // 屏幕位移 → 屏幕方向(已除 zoom 得世界尺度) → 世界方向
    const world = this.screenDirToWorld(dxScreen, dyScreen);
    this.setPosition(this.x + world.x, this.y + world.y);
  }

  /**
   * 以指定的屏幕坐标点为锚点**瞬时**缩放。
   * 保证锚点屏幕坐标在缩放前后不变——即"以鼠标为中心放大/缩小"。
   *
   * 语义是"直接设到某 zoom"，瞬时生效（无动画）。供 setZoom、verify 脚本、未来 UI 按钮
   * （如"重置视图"）使用。**滚轮缩放不经过此方法**——滚轮用速度惯性模型（见 zoomByWheel），
   * 因为滚轮是连续累加操作，瞬时跳变 + lerp 目标模型会有"滚时冻结/停手猛冲"的割裂感。
   *
   * @param screenAnchor 锚点的屏幕坐标（通常是鼠标位置）
   * @param newZoom      目标缩放（会先 clamp 到 [min,max]）
   */
  zoomAt(screenAnchor: { x: number; y: number }, newZoom: number): void {
    const clampedZoom = clamp(newZoom, this.minZoom(), CAMERA_ZOOM_MAX);
    if (clampedZoom === this.zoom) return;

    // 锚点的世界坐标在缩放前后应保持其屏幕位置不变:
    //   screen = R(−rot)*(world − camCenter)*zoom + viewportCenter
    // 保持 screen 不变 → (world − camCenter_new)*newZoom = (world − camCenter_old)*zoom
    //   （旋转 R(−rot) 两边同乘逆矩阵后抵消，结构退化为与无旋转相同）
    // 解出 camCenter_new = world − (world − camCenter_old) * zoom / newZoom
    // 这里 anchorWorld 由(已含旋转的) screenToWorld 求出，故对旋转天然正确。
    const anchorWorld = this.screenToWorld(screenAnchor.x, screenAnchor.y);
    const newX = anchorWorld.x - (anchorWorld.x - this.x) * (this.zoom / clampedZoom);
    const newY = anchorWorld.y - (anchorWorld.y - this.y) * (this.zoom / clampedZoom);

    this.zoom = clampedZoom;
    this.setPosition(newX, newY);
  }

  /**
   * 滚轮缩放（target lerp 模型，移植自旧 Flutter 项目）。滚轮专用入口。
   *
   * 手感（对味的关键）:
   *   - **deltaY 线性比例**: newTarget = targetZoom × (1 − deltaY / DIVISOR)。保留了滚轮的
   *     "力度"信息——滚得快(|deltaY|大)=缩放快，触控板连续小增量则丝滑变化。地图类应用标准做法。
   *   - **target 累乘 + display 指数趋近**: targetZoom 持续累乘，显示 zoom 由 update() 每帧向它
   *     趋近（不重置、连滚不冻结），停手后平滑追上 target，无猛冲。
   *
   * 锚点（无漂移）: 触发时用 screenToWorld 求出鼠标指向的世界坐标并固定，update() 趋近期间
   * 每帧用固定锚点反解相机中心（applyZoomAtAnchor），保证该世界点屏幕位置恒定。连滚时刷新锚点。
   *
   * @param screenAnchor 锚点的屏幕坐标（通常是鼠标位置）
   * @param deltaY       WheelEvent.deltaY（>0 向下滚缩小，<0 向上滚放大）
   */
  zoomByWheel(screenAnchor: { x: number; y: number }, deltaY: number): void {
    // 用目标值累乘（连滚时 target 持续推进，display 在 update 里追赶，不冻结）
    const oldTarget = this._targetZoom;
    const newTarget = clamp(
      this._targetZoom * (1 - deltaY / CAMERA_ZOOM_WHEEL_DELTA_DIVISOR),
      this.minZoom(), CAMERA_ZOOM_MAX,
    );
    if (Math.abs(newTarget - oldTarget) < 0.0001) return; // 无变化（如已撞边界）

    // 刷新固定锚点（连滚时鼠标可能移动，以新鼠标位置为准；用当前显示 zoom 求世界坐标）
    this._zoomAnchor = this.screenToWorld(screenAnchor.x, screenAnchor.y);
    this._targetZoom = newTarget;
  }

  /**
   * 用固定锚点（_zoomAnchor）反解相机中心，把 zoom 设为 newZoom。zoomByWheel/update 共用。
   *
   * 数学与瞬时 zoomAt 同式: camCenter_new = anchor − (anchor − camCenter_old) × zoomOld/zoomNew。
   * 已数值验证整个滑行过程锚点屏幕漂移≈0（浮点误差量级）。无锚点时（防御）只改 zoom。
   * clampPosition 保证世界边界约束生效（贴边时锚点无法精确保持，属预期）。
   */
  private applyZoomAtAnchor(newZoom: number): void {
    if (this._zoomAnchor) {
      const ratio = this.zoom / newZoom; // zoomOld / zoomNew
      this.x = this._zoomAnchor.x - (this._zoomAnchor.x - this.x) * ratio;
      this.y = this._zoomAnchor.y - (this._zoomAnchor.y - this.y) * ratio;
    }
    this.zoom = newZoom;
    this.clampPosition();
  }

  /** 直接设置缩放（以视口中心为锚点，瞬时）。 */
  setZoom(zoom: number): void {
    const cx = this.viewport.width / 2;
    const cy = this.viewport.height / 2;
    this.zoomAt({ x: cx, y: cy }, zoom);
  }

  /**
   * 视图顺时针旋转 90° (A6 §4.0, T1.5)。4 态循环 0→90→180→270→0。
   * 旋转以屏幕中心(=相机中心)为枢轴，故相机世界中心不变——只改变呈现方式。
   * 模拟层不感知此变化，下游系统通过 worldToScreen/screenToWorld 自动正确。
   *
   * 平滑过渡: 更新离散目标态 viewRotation，同时启动一段 lerp 动画把
   * displayRotation 从当前值过渡到新目标。动画期间所有坐标变换都用 displayRotation，
   * 故视觉与点击位置始终一致。若上一次动画未结束就再次触发(连按 Ctrl+R)，
   * 以当前 displayRotation 为新起点。
   *
   * ⚠️ 目标重锚定（关键，修正"连旋不回正"bug）:
   *   动画目标**必须锁定到 viewRotation 的精确离散弧度**，而非"起点 + π/2"累加。
   *   早期实现用 `_rotAnimTo = _rotAnimFrom + π/2`，每次从当前显示角(可能是动画中途值
   *   或 lerp 残差)累加，导致 displayRotation 随连按逐步漂离 viewRotation 的真实值
   *   —— 表现为"转 4 次回不到正"(viewRotation=0 但画面停在 ~93°)。
   *   现在目标 = 大于当前 displayRotation、且模 2π 等于 viewRotation*π/180 的最小值
   *   (nextClockwiseTarget)。这样: (a) 始终顺时针 ≥ 一个 90° 档位; (b) 动画结束后
   *   displayRotation mod 2π 严格 == viewRotation 对应弧度，每次都把漂移归零。
   */
  rotateClockwise(): void {
    this.viewRotation = (((this.viewRotation + 90) % 360) as ViewRotation);
    // 动画起点 = 当前显示角度(若上次动画进行中，从当前进度接续，无画面突变)
    this._rotAnimFrom = this._displayRotation;
    // 动画目标 = 锁定到 viewRotation 的精确离散弧度，顺时针取下一个 ≥ from 的值
    this._rotAnimTo = nextClockwiseTarget(this.viewRotation, this._displayRotation);
    this._rotAnimElapsed = 0;
  }

  /** 设置相机中心并 clamp 到世界边界内。 */
  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.clampPosition();
  }

  /**
   * 把相机变换同步到 PixiJS 世界容器。
   * PixiJS 的世界坐标系与本项目一致（原点左上、y 向下）。
   *
   * 旋转下的变换用 **pivot 方式**: 绕枢轴(相机中心)旋转 + 缩放，
   *   screen = viewportCenter + R(rotation) * zoom * (world − camCenter)
   * 对应 PixiJS Container:
   *   pivot     = camCenter          (局部原点 = 相机中心)
   *   position  = viewportCenter     (枢轴钉在视口中央)
   *   scale     = zoom
   *   rotation  = −displayRotation   (PixiJS rotation 正值=顺时针；displayRotation 是
   *              "视图顺时针"，需取负让 worldToScreen 的 −rad 符号一致)
   *
   * 用 displayRotation(连续)而非 viewRotation，使旋转过渡动画期间 PixiJS 容器
   * 实际旋转角度与坐标转换一致。rot=0 时退化为旧公式，逐像素一致(verify-t1.5)。
   */
  updateTransform(): void {
    if (!this.worldContainer) return;
    const c = this.worldContainer;
    c.scale.set(this.zoom);
    c.pivot.set(this.x, this.y);
    c.position.set(this.viewport.width / 2, this.viewport.height / 2);
    c.rotation = -this._displayRotation;
  }

  // ───────────────────────── 边界 ─────────────────────────

  /**
   * 将相机中心 clamp 到世界边界内 (A6 §4.1, A2 §8)。
   * 让世界边缘正好贴住视口边缘：相机中心 ∈ [halfView, worldSize - halfView]。
   * 当世界小于视口（极小缩放）时，相机居中，世界整体居中显示。
   */
  private clampPosition(): void {
    const halfW = this.viewport.width / 2 / this.zoom;
    const halfH = this.viewport.height / 2 / this.zoom;
    const worldW = this.bounds.widthPx;
    const worldH = this.bounds.heightPx;

    if (worldW >= halfW * 2) {
      this.x = clamp(this.x, halfW, worldW - halfW);
    } else {
      this.x = worldW / 2;
    }
    if (worldH >= halfH * 2) {
      this.y = clamp(this.y, halfH, worldH - halfH);
    } else {
      this.y = worldH / 2;
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** ease-in-out cubic: 进出场都柔和，旋转过渡看起来"有分量"不生硬。t∈[0,1]。 */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 计算旋转动画的顺时针目标弧度（修正"连旋不回正"bug，见 rotateClockwise 注释）。
 *
 * 目标必须满足两个约束:
 *   (1) 模 2π 等于 viewRotation 对应的精确弧度（保证动画结束后 displayRotation 与
 *       离散 viewRotation 严格对齐，不累积漂移）；
 *   (2) 大于 from（保证始终顺时针递进，Ctrl+R 语义是"顺时针 90°"，连按不反向）。
 *
 * 做法: 取 base = viewRotation*π/180（∈[0,2π)），不断 +2π 直到 > from。
 *   - 静止态按下（from 恰是上一档的精确值，如 from=0、目标 90°）: base=π/2 > 0 ✓
 *   - 动画中途连按（from 是中间值，如 from=0.3、目标应到 π/2）: π/2 > 0.3 ✓
 *   - 从 270° 再按一次回 0°: base=0，需 +2π → 2π > from(=3π/2) ✓（顺时针走完最后 90°）
 *
 * @param viewRotation 当前离散目标态 (0/90/180/270)
 * @param from         动画起点 = 当前 _displayRotation（可能为中间值）
 */
function nextClockwiseTarget(viewRotation: ViewRotation, from: number): number {
  const TAU = Math.PI * 2;
  let target = (viewRotation * Math.PI) / 180; // ∈ [0, 2π)
  while (target <= from) target += TAU;
  return target;
}

export { CELL_SIZE }; // 便于消费方从 camera 模块一并引入（可选）
