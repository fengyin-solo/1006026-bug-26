import type { EntryRow } from './types'

/**
 * 除冰作业领域核心：时长重算、明细口径、喷洒量汇总、状态机校验全部收在这一个文件。
 *
 * 之前的根因是重算只写在明细这一层，月度汇总另走一条路（沿用登记时手填的旧作业时长），
 * 结果同一条作业在明细里是一个数、在月度用量里是另一个数。现在页面动作层（views/deice）
 * 与本地数据层（api/local-service）都只读本文件的函数，明细与汇总共用同一套口径，
 * 不允许任何一方再单独保留一份重算。
 */

export const DEICE_KEY = 'deice'

export const DEICE_STATUSES = ['待除冰', '除冰中', '待确认', '已完成'] as const
export const DEICE_FINAL_STATUS = '已完成'

/**
 * 每个动作唯一合法的前置状态。必须逐级流转，跨级一律驳回：
 * 待除冰 -> 除冰中（开始除冰）-> 待确认（提交确认）-> 已完成（确认完成）。
 * 任何回头路（如从「除冰中」直接「确认完成」、从「待除冰」直接「提交确认」）都不允许。
 */
export const DEICE_ACTION_FROM: Record<string, string> = {
  开始除冰: '待除冰',
  提交确认: '除冰中',
  确认完成: '待确认',
}

/** 除冰任务状态机需要维护的时间字段：动作触发时在对应节点落时间戳。 */
export const DEICE_ACTION_TIME_FIELD: Record<string, string> = {
  开始除冰: '开始时间',
  提交确认: '结束时间',
}

/**
 * 时长登记值 vs 按起止时间算出来的值——冲突判定规则（两处冲突时怎么定）：
 *
 * 1. 开始时间、结束时间都能解析成合法时间，且结束不早于开始：以「起止时间重算值」为准，
 *    登记时手填的作业时长一律被覆盖，仅保留在「登记时长」字段里留痕，页面用「按起止时间」标注。
 *    理由：起止时间是作业节点的客观记录，手填值只是登记时的估填，二者冲突时信机器记录。
 * 2. 起止时间缺一个、无法解析，或结束早于开始（倒挂）：无法重算，回退沿用手填登记值，
 *    页面用「沿用登记」标注；手填值也不是合法数字时作业时长按 0 分钟处理。
 * 3. 「确认完成」是唯一触发重算的动作；重算只执行一次。重算结果同步回写明细与除冰液需求台账，
 *    两个出口读的都是这一个结果，不存在第二份数。
 */
export type DurationSource = 'computed' | 'registered' | 'empty'

export type DeiceJob = EntryRow & {
  开始时间: string
  结束时间: string
  作业时长: string
  登记时长: string
  作业分钟数: number
  时长口径: DurationSource
  喷洒量数值: number
  月份: string
}

export type DeiceLedgerEntry = {
  任务编号: string
  航班号: string
  除冰液型号: string
  喷洒量: number
  作业分钟数: number
  开始时间: string
  结束时间: string
  完成月份: string
}

export type FluidUsageRow = {
  除冰液型号: string
  作业架次: number
  喷洒量合计: number
  作业分钟合计: number
}

/** 把「2026-10-04 09:10」「2026-10-04T09:10」「2026-10-04」这类登记值解析成时间戳。 */
export function parseTime(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }
  const text = String(value).trim()
  if (!text) {
    return null
  }
  const normalized = text.includes('T') ? text : text.replace(' ', 'T')
  const ms = new Date(normalized).getTime()
  return Number.isNaN(ms) ? null : ms
}

function currentStamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** 动作节点落时间：已有值不覆盖（保证重复确认、重复点击不会把原始起止时间冲掉）。 */
export function stampActionTime(row: EntryRow, action: string): EntryRow {
  const field = DEICE_ACTION_TIME_FIELD[action]
  if (!field) {
    return row
  }
  const existing = String(row[field] ?? '').trim()
  if (existing) {
    return row
  }
  return { ...row, [field]: currentStamp() }
}

function parseNumber(value: unknown): number {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : 0
}

function monthOf(value: unknown): string {
  const ms = parseTime(value)
  if (ms === null) {
    return ''
  }
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

export function currentMonth(): string {
  return monthOf(currentStamp())
}

export type DurationResult = {
  minutes: number
  label: string
  source: DurationSource
}

/**
 * 唯一的时长重算函数：开始/结束时间合法且不倒挂时按差值重算（四舍五入到分钟），
 * 否则回退手填登记值。明细与汇总都只能拿这里的结果。
 */
export function recalcDuration(row: EntryRow): DurationResult {
  const start = parseTime(row['开始时间'])
  const end = parseTime(row['结束时间'])
  if (start !== null && end !== null && end >= start) {
    return { minutes: Math.round((end - start) / 60000), label: '按起止时间', source: 'computed' }
  }
  const registered = parseNumber(row['作业时长'])
  if (registered > 0) {
    return { minutes: registered, label: '沿用登记', source: 'registered' }
  }
  return { minutes: 0, label: '—', source: 'empty' }
}

/** 明细口径：同一条作业无论在哪个页面读，都经过这一遍统一重算。 */
export function normalizeDeiceJob(row: EntryRow): DeiceJob {
  const duration = recalcDuration(row)
  const registered = String(row['作业时长'] ?? '').trim()
  return {
    ...row,
    开始时间: String(row['开始时间'] ?? ''),
    结束时间: String(row['结束时间'] ?? ''),
    作业时长: duration.minutes > 0 ? `${duration.minutes}分钟（${duration.label}）` : '—',
    登记时长: registered,
    作业分钟数: duration.minutes,
    时长口径: duration.source,
    喷洒量数值: parseNumber(row['喷洒量']),
    月份: monthOf(row['结束时间']) || monthOf(row['开始时间']),
  }
}

/** 汇总口径：月度用量与需求台账都由这个函数派生，喷洒量直接取登记的当次用量，不再乘旧时长。 */
export function buildDeiceLedgerEntry(row: EntryRow): DeiceLedgerEntry {
  const job = normalizeDeiceJob(row)
  return {
    任务编号: String(row['任务编号'] ?? ''),
    航班号: String(row['航班号'] ?? ''),
    除冰液型号: String(row['除冰液型号'] ?? ''),
    喷洒量: job.喷洒量数值,
    作业分钟数: job.作业分钟数,
    开始时间: job.开始时间,
    结束时间: job.结束时间,
    完成月份: job.月份,
  }
}

/** 只有「已完成」的作业才计入用量；未完成的作业不产生实际消耗。 */
export function buildDeiceLedger(rows: EntryRow[]): DeiceLedgerEntry[] {
  return rows
    .filter((row) => String(row.status) === DEICE_FINAL_STATUS)
    .map(buildDeiceLedgerEntry)
}

/** 按除冰液型号汇总月度用量。明细与月度统计共用，保证同一条作业两边读出来的数一致。 */
export function summarizeFluidUsage(
  rows: EntryRow[],
  month: string = currentMonth(),
): { rows: FluidUsageRow[]; total: number } {
  const buckets = new Map<string, FluidUsageRow>()
  for (const entry of buildDeiceLedger(rows)) {
    if (entry.完成月份 !== month) {
      continue
    }
    const key = entry.除冰液型号 || '未登记型号'
    const bucket = buckets.get(key) ?? {
      除冰液型号: key,
      作业架次: 0,
      喷洒量合计: 0,
      作业分钟合计: 0,
    }
    bucket.作业架次 += 1
    bucket.喷洒量合计 += entry.喷洒量
    bucket.作业分钟合计 += entry.作业分钟数
    buckets.set(key, bucket)
  }
  const list = [...buckets.values()].sort((a, b) => a.除冰液型号.localeCompare(b.除冰液型号, 'zh-Hans-CN'))
  return { rows: list, total: list.reduce((sum, item) => sum + item.喷洒量合计, 0) }
}
