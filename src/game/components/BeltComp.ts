export interface BeltComp {
  direction: 'up' | 'down' | 'left' | 'right';
  speed: number;
  items: { id: string; progress: number }[];
}
