// 传送带预览染色 Filter —— 把传送带纹理整体染成蓝/红，保持透明区域透明
// 依据: T2.0 预览需要与设备放置预览一致的蓝色 (#76BBEA)，而 Sprite.tint 会把黄色带身乘成绿色。
//
// 与 PreviewTintFilter 不同：传送带预览不需要保留箭头变白，只需要整体替换颜色，
// 因此 fragment 直接输出统一颜色 × 原 alpha，不依赖 mask。

import { Filter, GlProgram, UniformGroup } from 'pixi.js';
import { defaultFilterVertex } from './defaultFilterVertex';

/** 可放置（蓝）: #76BBEA */
const VALID_RGB = new Float32Array([0x76 / 255, 0xbb / 255, 0xea / 255]);
/** 不可放置（红）: #E45050 */
const INVALID_RGB = new Float32Array([0xe4 / 255, 0x50 / 255, 0x50 / 255]);

const fragmentSource = `
in vec2 vTextureCoord;
in vec4 vColor;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec3 uColor;

void main()
{
    vec4 color = texture(uTexture, vTextureCoord);
    if (color.a <= 0.001) {
        discard;
    }
    finalColor = vec4(uColor * color.a, color.a);
}
`;

export class BeltPreviewTintFilter extends Filter {
  constructor() {
    const glProgram = GlProgram.from({
      vertex: defaultFilterVertex,
      fragment: fragmentSource,
      name: 'belt-preview-tint',
    });
    super({
      glProgram,
      padding: 0,
      resources: {
        tintUniforms: new UniformGroup({
          uColor: { value: VALID_RGB, type: 'vec3<f32>' },
        }),
      },
    });
  }

  /** true=可放置(蓝)，false=不可放置(红)。 */
  setValid(valid: boolean): void {
    this.resources.tintUniforms.uniforms.uColor = valid ? VALID_RGB : INVALID_RGB;
  }
}
