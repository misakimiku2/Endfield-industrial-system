// 预览染色 Filter — 设备主体纯色染色 + 端口箭头变白（双纹理 mask + UV 变换方案）
// 依据: T1.7 放置预览染色需求（用户反馈"设备整体直接变蓝，端口箭头变白"）
//
// 实现演进（为什么用 mask 而非颜色识别）:
//   端口区域全是消色差灰色（箭头 stroke #828080、连接器柱 fill #828080、面板 #cbc9c9/#e0dede）。
//   前版按"颜色距离接近 #828080 → 白"识别箭头，但灰度空间插值必然导致端口灰色元素的抗锯齿
//   交界中点复现 #828080（如 #202020↔#cbc9c9 交界中点 #767575 距 #828080 仅 0.08），
//   被误判为箭头 → 端口出现白色缝隙。调颜色阈值无法两全。
//
//   根本解法: 构建期(pack-assets.ts)在矢量层精确分离箭头 path（正则匹配 fill:none + stroke:#828080），
//   生成"白色箭头 + 透明背景"的 mask 纹理打包进图集。运行时 filter 双纹理采样：
//   设备原图(uTexture)染主体色，mask(uMaskTexture)指示哪里是箭头 → 白。
//
// ⚠️ 关键: mask UV 坐标变换（修复"颜色完全错乱"bug）
//   uTexture 不是 spritesheet 图集纹理，而是 PixiJS filter 系统从 TexturePool 借出的**独立
//   render-target**（sprite 先画进 render-target，filter 再采样）。故 vTextureCoord 是
//   render-target 内坐标（范围 [0, bounds/po2]，非图集 UV，也非 0~1）。
//
//   而 uMaskTexture 绑定的是**整个图集 source**（4096×1024），mask 帧只是其中一帧（frame
//   {x:772,y:2,w:768,h:768}）。直接 texture(uMaskTexture, vTextureCoord) 会用 render-target
//   坐标采整个图集 → 采样到图集其它区域 → 颜色错乱。
//
//   修复: shader 先把 vTextureCoord 还原成设备局部 [0,1]（除以 uOutputFrame.zw*uInputSize.zw，
//   这两个是 filter 系统自动注入的内置 uniform），再用 uMaskUvRect（mask 帧在图集的 UV rect）
//   映射进 mask 帧。setMask 时从 Texture.uvs 对象读取该 rect（自动适配图集重排/rotate/trim）。
//
//   注意: PixiJS v8 的 Texture.uvs 是**对象**（{x0,y0,x1,y1,x2,y2,x3,y3}），不是数组。
//
//   仅作用于预览 Sprite；已放置设备用原图无 filter，保持原始外观。

import { Filter, GlProgram, Texture, UniformGroup } from 'pixi.js';
import { defaultFilterVertex } from './defaultFilterVertex';

/** RGB 颜色通道（0xRRGGBB 整数）。 */
type HexColor = number;

// ───────────────────────── 颜色常量 ─────────────────────────

/** 可创建（蓝）: #76BBEA */
const VALID_COLOR = 0x76bbea;
/** 不可创建（橙红）: #e45050 */
const INVALID_COLOR = 0xe45050;

// ───────────────────────── 颜色 → vec3 ─────────────────────────

/** 0xRRGGBB → 归一化 RGB 字符串（注入 GLSL 源码，编译期常量）。 */
function hexToVec3(hex: HexColor): string {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return `vec3(${r}, ${g}, ${b})`;
}

// ───────────────────────── fragment shader ─────────────────────────

/**
 * 构建当前 valid 状态对应的 fragment shader 源码。
 * valid/invalid 差异只是主体色常量，编进源码（编译期常量），切换状态时重建 GlProgram。
 *
 * 双纹理 + UV 变换:
 *   - uTexture(设备原图，filter 系统自动绑定为 render-target source)
 *   - uMaskTexture(箭头 mask，resources 注入；绑定整个图集 source)
 *   - uInputSize/uOutputFrame(filter 系统自动注入的内置 uniform，用于还原设备局部 [0,1])
 *   - uMaskUvRect(mask 帧在图集的 UV rect，setMask 时从 Texture.uvs 读取注入)
 *
 *   vTextureCoord 是 render-target 内坐标（非 0~1，非图集 UV），采样 mask 前需坐标变换。
 */
function buildFragment(valid: boolean): string {
  const bodyColor = valid ? VALID_COLOR : INVALID_COLOR;
  return `
in vec2 vTextureCoord;
in vec4 vColor;
out vec4 finalColor;

// filter 系统自动注入的内置 uniform（group 0），声明即可用，不要在 resources 重复注入。
// ⚠️ 精度必须显式声明 highp 与 vertex(defaultFilterVertex) 对齐:
//    PixiJS 给 vertex 注入 precision highp float、fragment 注入 mediump float（见
//    GlProgram.defaultOptions.preferredVertexPrecision/preferredFragmentPrecision）。
//    若 fragment 不显式声明，同名 uniform 在 vert/frag 精度不一致 → GLSL 链接失败
//    "Precisions of uniform 'uInputSize' differ" → shader 编译失败 → filter 不生效。
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;
uniform sampler2D uTexture;
// resources 注入
uniform sampler2D uMaskTexture;
uniform vec4 uMaskUvRect;   // (uvX0, uvY0, uvX1, uvY1) mask 帧在图集的 UV rect
uniform float uRotation;    // 预览 Sprite 的 rotation（弧度），同步旋转 mask

void main()
{
    vec4 color = texture(uTexture, vTextureCoord);
    // 完全透明像素丢弃（保持设备外透明区域透明）
    if (color.a <= 0.001) {
        discard;
    }

    // ⚠️ 坐标变换（修复采样错乱）:
    //   vTextureCoord 是 render-target 内坐标（范围 [0, bounds/po2]，非 0~1）。
    //   defaultFilter.vert 中 vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw)，
    //   aPosition ∈ [0,1]，故除回去即得设备局部 [0,1]。
    vec2 local01 = vTextureCoord / (uOutputFrame.zw * uInputSize.zw);

    // 同步预览 Sprite 旋转：以设备中心为原点旋转 mask UV。
    // PixiJS rotation 正值=顺时针（y 向下坐标系），对应矩阵 [c -s; s c]。
    vec2 centered = local01 - 0.5;
    float c = cos(uRotation);
    float s = sin(uRotation);
    vec2 rotated = vec2(
        c * centered.x - s * centered.y,
        s * centered.x + c * centered.y
    );
    vec2 maskLocal = clamp(rotated + 0.5, 0.0, 1.0);

    // 映射进 mask 帧在图集的 UV rect（uMaskTexture 是整个图集 source）。
    vec2 maskUv = mix(uMaskUvRect.xy, uMaskUvRect.zw, maskLocal);

    // 箭头权重: mask 的 R 通道（白色箭头=1，透明背景=0）。mask 自身抗锯齿边缘平滑，无锯齿。
    float arrowWeight = texture(uMaskTexture, maskUv).r;

    // 反预乘 alpha（PixiJS 纹理是预乘格式），还原真实 RGB
    vec3 rgb = color.rgb / color.a;
    // 箭头→白，主体→纯色，按 mask 权重混合
    vec3 outRgb = mix(${hexToVec3(bodyColor)}, vec3(1.0), arrowWeight);

    // 预乘回 alpha
    finalColor = vec4(outRgb * color.a, color.a);
}
`;
}

// ───────────────────────── Filter ─────────────────────────

/**
 * 预览染色 Filter（双纹理 mask + UV 变换方案）。
 *
 * 设备主体 → 纯色（可放置=蓝/不可放置=橙红），端口箭头 → 白色（由 mask 精确指示）。
 * 仅作用于预览 Sprite；已放置设备用原图无 filter，保持原始外观。
 *
 * 双纹理: uTexture(系统自动绑定的 render-target) + uMaskTexture(箭头 mask，整个图集 source)。
 *   因 uMaskTexture 是整个图集、mask 帧只是其中一帧，需 uMaskUvRect 做坐标变换。
 */
export class PreviewTintFilter extends Filter {
  /** 当前编译的状态，避免重复构建同名 GlProgram。 */
  private currentValid = true;

  constructor() {
    const glProgram = GlProgram.from({
      vertex: defaultFilterVertex,
      fragment: buildFragment(true),
      name: 'preview-tint-valid',
    });
    super({
      glProgram,
      // padding 会让 filter 输出帧比设备包围盒大，导致 mask UV 缩放错位；本 filter 只需内部采样，设 0
      padding: 0,
      resources: {
        // uMaskTexture 注入 group 99（PixiJS 自动），初始用 EMPTY 占位，setMask 时替换为图集 source
        uMaskTexture: Texture.EMPTY.source,
        // maskUniforms: 含 uMaskUvRect（mask 帧在图集的 UV rect）与 uRotation（同步旋转）
        maskUniforms: new UniformGroup({
          uMaskUvRect: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
          uRotation: { value: 0, type: 'f32' },
        }),
      },
    });
  }

  /**
   * 注入箭头 mask 纹理（由 PlacementSystem 在换设备纹理时调用）。
   *
   * 同时绑定 mask 的图集 source 与 UV rect。UV rect 从 Texture.uvs 对象读取
   * （自动适配图集重排/rotate/trim，不手算 frame/source）。
   *
   * @param maskTexture 箭头 mask Texture（图集中的一帧）；undefined 时用 EMPTY 占位
   */
  setMask(maskTexture: Texture | undefined): void {
    const tex = maskTexture ?? Texture.EMPTY;
    this.resources.uMaskTexture = tex.source;
    // PixiJS v8 的 Texture.uvs 是对象 {x0,y0,x1,y1,x2,y2,x3,y3}，取左上角(x0,y0)和右下角(x2,y2)
    const u = tex.uvs;
    this.resources.maskUniforms.uniforms.uMaskUvRect = new Float32Array([u.x0, u.y0, u.x2, u.y2]);
  }

  /**
   * 同步预览 Sprite 的旋转角度（弧度），使 mask 箭头随设备一起旋转。
   * @param rotation 与 preview.rotation 相同的弧度值
   */
  setRotation(rotation: number): void {
    this.resources.maskUniforms.uniforms.uRotation = rotation;
  }

  /**
   * 切换颜色状态。
   * @param valid true=可创建(蓝)，false=不可创建(橙红)
   */
  setValid(valid: boolean): void {
    if (valid === this.currentValid) return;
    this.currentValid = valid;
    this.glProgram = GlProgram.from({
      vertex: defaultFilterVertex,
      fragment: buildFragment(valid),
      name: valid ? 'preview-tint-valid' : 'preview-tint-invalid',
    });
  }
}
