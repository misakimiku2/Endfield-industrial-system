import type { Entity } from '../ECS';

export interface TurretComp {
  range: number;
  fireRate: number;    // 每秒射击次数
  damage: number;
  cooldown: number;
  target: Entity | null;
}
