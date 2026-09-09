// 设备耗电数据 — 设备 CSV 驱动（T2.15 用户反馈: 弹窗耗电数不是固定值，
// 以 doc/csv/ 终末地设备*.csv 的「耗电峰值（单位/W）」列为权威源）
// 依据: doc/csv/终末地设备 - {合成制造,基础生产,仓储存取}.csv（三份含耗电列；
//       物流设备/电力两份无耗电列，加载器按表头自动跳过）。
//
// CSV 行: 设备名称, 唯一英文ID, 耗电峰值（单位/W）, ...（英文ID 如 "Refining Unit"）
// 映射: slugify(英文ID) === BuildingDefinition.id（"Refining Unit" → "refining_unit"，
//       与 items.ts slugifyItemId 同一归一化）。匹配到的定义在**启动时**覆写
//       powerConsumption（数据加载步骤，与 recipes/items 同期；此后运行时仍按只读对待）。
// 未匹配行（本作未实现的设备）计入 skipped 供日志核对，无副作用。

import { splitCsvLine, slugifyItemId } from './items.ts';
import { BUILDING_DEFINITIONS } from './buildings.ts';

export interface EquipmentPowerReport {
  /** 成功覆写耗电的设备数 */
  loaded: number;
  /** CSV 中存在但本作未定义的设备名（核对用，仅告警） */
  skipped: string[];
}

const POWER_COLUMN = '耗电峰值';

/**
 * 从设备 CSV 文本集合加载耗电峰值，覆写 BUILDING_DEFINITIONS 的 powerConsumption。
 * 幂等（重复调用以最后一次为准）；无耗电列的文件自动跳过。
 */
export function applyEquipmentPower(csvTexts: string[]): EquipmentPowerReport {
  const report: EquipmentPowerReport = { loaded: 0, skipped: [] };
  for (const csv of csvTexts) {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;
    const header = splitCsvLine(lines[0]);
    const powerCol = header.findIndex((h) => h.includes(POWER_COLUMN));
    if (powerCol < 0) continue; // 无耗电列（物流设备/电力表）→ 跳过整份

    for (const line of lines.slice(1)) {
      const cols = splitCsvLine(line);
      const name = cols[0]?.trim() ?? '';
      const enId = cols[1]?.trim() ?? '';
      const power = Number.parseFloat(cols[powerCol] ?? '');
      if (!name || !enId || !Number.isFinite(power)) continue;
      const def = BUILDING_DEFINITIONS[slugifyItemId(enId)];
      if (!def) {
        if (!report.skipped.includes(name)) report.skipped.push(name);
        continue;
      }
      def.powerConsumption = power;
      report.loaded++;
    }
  }
  return report;
}
