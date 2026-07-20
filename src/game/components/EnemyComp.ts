export interface EnemyComp {
  hp: number;
  maxHp: number;
  speed: number;
  path: { x: number; y: number }[];
  pathIndex: number;
  reward: number;
}
