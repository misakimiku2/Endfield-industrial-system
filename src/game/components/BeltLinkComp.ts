// 传送带连接组件 — T2.0 阶段 2 链管理使用
// 依据: implementation-phase-2.md T2.0 §数据模型
//
// 记录段与段、段与设备端口之间的拓扑关系。
// 阶段 1 暂不写入此组件（只创建单段/单链），阶段 2 延长/删除时启用。

import type { EntityHandle } from '../ECS';

/**
 * 传送带连接组件。
 */
export interface BeltLinkComp {
  /** 上游段，null 表示起点接设备输出端口。 */
  prev: EntityHandle | null;
  /** 下游段，null 表示当前是链尾。 */
  next: EntityHandle | null;
  /** 起点连接的设备端口（可选）。 */
  sourcePort: {
    buildingHandle: EntityHandle;
    portIndex: number;
  } | null;
}
