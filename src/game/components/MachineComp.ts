export interface MachineComp {
  type: 'furnace' | 'assembler' | 'miner';
  recipe: string | null;
  progress: number;
  input: string[];   // 输入物品 ID 列表
  output: string[];  // 输出物品 ID 列表
}
