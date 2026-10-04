import type { EntryRow } from './types'

// 除冰作业的重算规则只认这一个地方：
// 页面动作层（api/local-service.ts）与本地数据层（data/local-store.ts）都调这里，
// 明细列表、月度用量汇总、除冰液需求台账读到的是同一份结果，不会再各算各的。

export const DEICE_KEY = 'deice'
export const DEICE_LEDGER_KEY = 'deiceLedger'
export const DEICE_CONFIRM_ACTION = '确认完成'
export const DEICE_DONE_STATUS = '已完成'

export const DEICE_FIELD = {
  taskNo: '任务编号',
  fluid: '除冰液型号',
  spray: '喷洒量',
  start: '开始时间',
  end: '结束时间',
  registered: '登记时长',
  duration: '作业时长',
  durationSource: '时长来源',
  recalcAt: '重算时间',
  accounted: '用量已入账',
} as const

// 时长来源：登记值与起止时间算出的值冲突时，以哪一处为准，写进这一列存档备查。
export const DURATION_SOURCE = {
  computed: '起止时间重算',
  fallbackMissing: '登记值（起止时间缺失）',
  fallbackInvalid: '登记值（起止时间无效）',
} as const

export type FluidUsageSummary = {
  fluid: string
  amount: number
  tasks: number
  lastRecalcAt: string
}

function toNumber(raw: unknown): number | null {
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function parseDateTime(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null
  }
  const time = new Date(raw.trim().replace(' ', 'T')).getTime()
  return Number.isNaN(time) ? null : time
}

export function formatDateTime(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}

/** 起止时间都有效且结束晚于开始时，返回作业分钟数；否则返回 null，表示要回退登记值。 */
export function computeDurationMinutes(startRaw: unknown, endRaw: unknown): number | null {
  const start = parseDateTime(startRaw)
  const end = parseDateTime(endRaw)
  if (start === null || end === null || end <= start) {
    return null
  }
  return Math.round((end - start) / 60000)
}

/**
 * 时长冲突判定规则（明细、汇总、台账共用这一条）：
 * 1. 开始时间与结束时间都填了、且结束晚于开始 → 以起止时间算出的分钟数为准，
 *    登记时手填的旧值保留在「登记时长」里只作存档，不再参与任何计算；
 * 2. 起止时间缺任一 → 回退登记值，时长来源记「登记值（起止时间缺失）」；
 * 3. 起止时间都填了但解析失败或结束不晚于开始 → 回退登记值，记「登记值（起止时间无效）」。
 * 纯函数、幂等：同一行跑多少遍结果都一样，重复确认完成不会算出第二个数。
 */
export function normalizeDeiceRow(row: EntryRow): EntryRow {
  // 登记时长只补录一次：老数据没有这一列，首次用当时的作业时长顶上来存档，之后不再动它。
  const registered = toNumber(row[DEICE_FIELD.registered]) ?? toNumber(row[DEICE_FIELD.duration]) ?? 0
  const computed = computeDurationMinutes(row[DEICE_FIELD.start], row[DEICE_FIELD.end])
  const startRaw = String(row[DEICE_FIELD.start] ?? '').trim()
  const endRaw = String(row[DEICE_FIELD.end] ?? '').trim()
  let source: string
  if (computed !== null) {
    source = DURATION_SOURCE.computed
  } else if (startRaw === '' || endRaw === '') {
    source = DURATION_SOURCE.fallbackMissing
  } else {
    source = DURATION_SOURCE.fallbackInvalid
  }
  return {
    ...row,
    [DEICE_FIELD.registered]: registered,
    [DEICE_FIELD.duration]: computed ?? registered,
    [DEICE_FIELD.durationSource]: source,
  }
}

/**
 * 「确认完成」时的落锤重算：归一化之后盖一次章（重算时间、用量已入账）。
 * 已入账的行原样返回，不重复盖章——重复确认完成只重算一次，用量不会被加两遍。
 */
export function finalizeDeiceRow(row: EntryRow, now: Date = new Date()): EntryRow {
  const normalized = normalizeDeiceRow(row)
  if (normalized[DEICE_FIELD.accounted] === true) {
    return normalized
  }
  return {
    ...normalized,
    [DEICE_FIELD.recalcAt]: formatDateTime(now),
    [DEICE_FIELD.accounted]: true,
  }
}

/**
 * 月度归属：以结束时间所在月为准，缺结束时间看开始时间；
 * 起止都没有的（确认完成时一定会盖重算时间），按重算时间所在月入账；
 * 三者都没有的老数据无法归属月份，不计入月度统计。
 */
function completionMonthKey(row: EntryRow): string | null {
  const time =
    parseDateTime(row[DEICE_FIELD.end]) ??
    parseDateTime(row[DEICE_FIELD.start]) ??
    parseDateTime(row[DEICE_FIELD.recalcAt])
  if (time === null) {
    return null
  }
  const date = new Date(time)
  return `${date.getFullYear()}-${date.getMonth()}`
}

/** 本月除冰液用量：按型号汇总「已完成」任务的喷洒量，入参必须已过 normalizeDeiceRow。 */
export function summarizeFluidUsage(rows: EntryRow[], now: Date = new Date()): FluidUsageSummary[] {
  const monthKey = `${now.getFullYear()}-${now.getMonth()}`
  const byFluid = new Map<string, FluidUsageSummary>()
  for (const row of rows) {
    if (String(row.status) !== DEICE_DONE_STATUS) {
      continue
    }
    if (completionMonthKey(row) !== monthKey) {
      continue
    }
    const fluid = String(row[DEICE_FIELD.fluid] ?? '').trim() || '未登记型号'
    const entry = byFluid.get(fluid) ?? { fluid, amount: 0, tasks: 0, lastRecalcAt: '' }
    entry.amount += toNumber(row[DEICE_FIELD.spray]) ?? 0
    entry.tasks += 1
    const recalcAt = String(row[DEICE_FIELD.recalcAt] ?? '')
    if (recalcAt > entry.lastRecalcAt) {
      entry.lastRecalcAt = recalcAt
    }
    byFluid.set(fluid, entry)
  }
  return [...byFluid.values()].sort((a, b) => a.fluid.localeCompare(b.fluid, 'zh-Hans-CN'))
}

/**
 * 除冰液需求台账：由已完成任务整体重建（不是增量累加），
 * 所以重复确认完成、重复落库都不会把用量加两遍。保障资源调度读的就是这张表。
 */
export function buildFluidLedger(rows: EntryRow[], now: Date = new Date()): EntryRow[] {
  const month = formatDateTime(now).slice(0, 7)
  return summarizeFluidUsage(rows, now).map((item, index) => ({
    id: index + 1,
    status: '已入账',
    pending: false,
    abnormal: false,
    除冰液型号: item.fluid,
    台账月份: month,
    本月用量: item.amount,
    入账任务数: item.tasks,
    最近重算时间: item.lastRecalcAt || '—',
    数据来源: '除冰作业重算回写',
  }))
}
