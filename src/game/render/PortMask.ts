// 端口掩码 — T1.12（方案 S3 nineslice-port-variant.md §2/§5.2）
//
// 视觉端口 = 逻辑端口的派生：单一真相源是 BuildingDefinition.ports，不新增设备
// 定义字段。四边各一组位图（solid/liquid 各一张）：
//   - 顶/底边按列 dx 置位（top.solid |= 1<<dx …）
//   - 左/右边按行 dy 置位（left.liquid |= 1<<dy …）
// 掩码定义在默认朝向（0°），容器整体旋转时视觉口随逻辑口一起转。
//
// 本模块是叶子模块（仅 type import，零运行时依赖）——verify 脚本可直接经
// node --experimental-strip-types 导入做离线单测。
//
// 方向约定（kit 切片按此定型，S3 §2）：顶边 = 输出口造型、底边 = 输入口造型；
// 左边 = 液体出口（黄点）、右边 = 液体进口（白点）；顶/底液体口 = 顶出（黄点）
// 底入（白点）。违反约定的口（如顶边输入口）走设备 equipment 层自画（§7.2）。

import type { BuildingDefinition } from '../data/buildings';

/** 一条边的端口位图（solid/liquid 各一张；顶/底边按列 dx 置位，左右边按行 dy 置位）。 */
export interface EdgePorts {
  solid: number;
  liquid: number;
}

/** 四边端口位图（S3 §2）。left.solid/right.solid 结构预留（§7.2 固体侧口暂无需求）。 */
export interface PortMask {
  top: EdgePorts;
  bottom: EdgePorts;
  left: EdgePorts;
  right: EdgePorts;
}

/** 全零掩码（无端口设备 = 纯底座 + 侧边装饰条）。 */
export function emptyPortMask(): PortMask {
  return {
    top: { solid: 0, liquid: 0 },
    bottom: { solid: 0, liquid: 0 },
    left: { solid: 0, liquid: 0 },
    right: { solid: 0, liquid: 0 },
  };
}

/**
 * 掩码 → 稳定字符串键（烘焙纹理缓存键的组成部分）。
 * 同尺寸同掩码的设备共享一张烘焙纹理；缓存规模 ≈ 设备款数（每款 ports 唯一）。
 */
export function portMaskKey(mask: PortMask): string {
  const e = (p: EdgePorts) => `s${p.solid},l${p.liquid}`;
  return `t${e(mask.top)};b${e(mask.bottom)};l${e(mask.left)};r${e(mask.right)}`;
}

/**
 * 从设备定义派生四边端口掩码。
 *
 * 过渡规则（现 PortType = 'input'|'output'|'liquid'，液体口无方向字段，S3 §5.2）:
 *   type=input,  dy=h-1 → bottom.solid |= 1<<dx（底边输入口）
 *   type=output, dy=0   → top.solid    |= 1<<dx（顶边输出口）
 *   type=liquid, dx=0   → left.liquid  |= 1<<dy（左=出口，现精炼炉约定）
 *   type=liquid, dx=w-1 → right.liquid |= 1<<dy（右=进口）
 *   type=liquid, dy=0/dy=h-1（顶/底液体口）→ 不进掩码——顶/底液体口需要
 *   方向信息（出入口），等 A3 端口模型"方向×介质"拆分后启用（§7.1），
 *   此前此类口走 equipment 自画。
 *   角格（dx=0 且 dy=0 等）按上表顺序取 dx 规则（§5.2 表序）。
 * 不落在上述约定边的口（如左边固体口）不产生视觉，同样走 equipment 自画（§7.2）。
 */
export function portMaskFromDef(def: BuildingDefinition): PortMask {
  const mask = emptyPortMask();
  const { w, h } = def.footprint;
  for (const port of def.ports) {
    const { dx, dy } = port.position;
    if (dx < 0 || dx >= w || dy < 0 || dy >= h) continue; // 越界防御，忽略
    if (port.type === 'input') {
      if (dy === h - 1) mask.bottom.solid |= 1 << dx;
    } else if (port.type === 'output') {
      if (dy === 0) mask.top.solid |= 1 << dx;
    } else {
      // liquid: 无方向字段，按位置约定（左出右入）
      if (dx === 0) mask.left.liquid |= 1 << dy;
      else if (dx === w - 1) mask.right.liquid |= 1 << dy;
      // dx=0/w-1 优先：角格液体口归侧边；其余（含顶/底边）等 A3 拆分后启用
    }
  }
  return mask;
}
