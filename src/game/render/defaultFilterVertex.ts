// PixiJS v8 filter 默认 vertex shader（内联副本）
//
// 来源: pixi.js/lib/filters/defaults/defaultFilter.vert.mjs
// PixiJS 未把此 vertex 源码作为公开 API 导出，自定义 Filter 需复用它来正确计算
// filter quad 的裁剪位置与纹理坐标。aPosition / uInputSize / uOutputFrame /
// uOutputTexture 由 PixiJS filter 系统在运行时自动绑定，无需手动提供。
//
// 内容与官方源逐字一致，PixiJS 升级时若该 vertex 改动需同步。

export const defaultFilterVertex = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;

    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;
