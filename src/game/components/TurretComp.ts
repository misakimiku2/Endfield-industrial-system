import type { EntityHandle } from '../ECS';

export interface TurretComp {
  range: number;
  fireRate: number;    // 每秒射击次数
  damage: number;
  cooldown: number;
  // 注: A1 §2.2 规定 Component 字段不应引用 EntityHandle。塔防索敌需引用目标实体，
  // 属于该规则的已知张力点；Phase 3 实现时改用空间查询或目标坐标等方案解除耦合。
  target: EntityHandle | null;
}
