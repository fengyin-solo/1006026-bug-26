import {
  buildDeiceLedger,
  currentMonth,
  DEICE_ACTION_FROM,
  DEICE_FINAL_STATUS,
  DEICE_KEY,
  DEICE_STATUSES,
  normalizeDeiceJob,
  stampActionTime,
  summarizeFluidUsage,
  type DeiceJob,
  type DeiceLedgerEntry,
  type FluidUsageRow,
} from '@/data/deice'
import {
  listCollection,
  listRows,
  resetCollection,
  resetRows,
  saveCollection,
  saveRows,
} from '@/data/local-store'
import type { ActionResult, EntryRow, PageResult } from '@/data/types'

/**
 * 除冰作业本地数据服务：页面动作层（views/deice）只能走这里，明细与汇总的重算
 * 都收口到 data/deice.ts，本文件只负责状态机、落库与台账回写。
 */

// 除冰液需求台账在通用集合存储里的 key：保障资源调度这条线读的就是它。
const LEDGER_COLLECTION_KEY = 'deice-fluid-ledger'

function listDeiceRows(): EntryRow[] {
  return listRows(DEICE_KEY)
}

/** 明细读取：统一过 normalizeDeiceJob 重算，页面拿到的作业时长不再可能是手填旧值。 */
export function listDeiceJobs(filters: Record<string, string> = {}): PageResult {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const jobs = listDeiceRows()
    .map(normalizeDeiceJob)
    .filter((job) =>
      pairs.every(([field, value]) => String(job[field] ?? '').includes(value.trim())),
    )
  return { items: jobs, total: jobs.length, page: 1, size: jobs.length }
}

/**
 * 读除冰液需求台账。台账必须与已完成作业明细始终对齐：每次读取按明细重新派生，
 * 并把结果落库——因此无论是动作回写还是刷新后读取，资源调度那边看到的数都和这里一样，
 * 不会出现「明细改了、台账还是旧的」。
 */
export function getDeiceLedger(): DeiceLedgerEntry[] {
  const derived = buildDeiceLedger(listDeiceRows())
  saveCollection(LEDGER_COLLECTION_KEY, derived)
  return listCollection<DeiceLedgerEntry>(LEDGER_COLLECTION_KEY)
}

/** 月度用量：和台账、明细同一个重算出口，按除冰液型号汇总。 */
export function deiceFluidUsage(month: string = currentMonth()): {
  month: string
  rows: FluidUsageRow[]
  total: number
} {
  const summary = summarizeFluidUsage(listDeiceRows(), month)
  return { month, rows: summary.rows, total: summary.total }
}

/**
 * 除冰作业动作流转（唯一入口）：
 * 1. 跨入口一致——入口动作（状态机校验）、落库写入（saveRows/saveCollection）、
 *    后续步骤读到的既有状态（getDeiceLedger/normalizeDeiceJob）三者同时成立，一次调用内完成。
 * 2. 不允许回到「除冰中」：只有 待除冰->除冰中->待确认->已完成 这一条逐级路线，
 *    跨级动作（如「除冰中」直接「确认完成」「驳回/撤销」类回头路）一律驳回。
 * 3. 「确认完成」只重算一次：重算结果回写明细并按任务编号 upsert 进除冰液需求台账，
 *    同一条任务重复确认不会把喷洒量加第二遍。
 */
export function applyDeiceAction(id: number, action: string): ActionResult {
  const requiredFrom = DEICE_ACTION_FROM[action]
  if (!requiredFrom) {
    return { ok: false, message: `除冰任务没有登记「${action}」这个动作` }
  }
  const rows = listDeiceRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的除冰任务` }
  }
  const current = String(rows[index].status)

  // 逐级流转：前置状态不匹配就是跨级，连同「完成后再驳回」的回头路一起拦下。
  if (current !== requiredFrom) {
    if (!DEICE_STATUSES.includes(current as (typeof DEICE_STATUSES)[number])) {
      return { ok: false, message: `除冰任务当前状态「${current}」异常，禁止流转` }
    }
    return {
      ok: false,
      message: `除冰任务需从「${requiredFrom}」执行「${action}」，当前是「${current}」，禁止跨级流转`,
    }
  }

  // 落时间戳：开始除冰写开始时间，提交确认写结束时间；已有值不覆盖。
  const stamped = stampActionTime(rows[index], action)
  const target =
    action === '开始除冰'
      ? '除冰中'
      : action === '提交确认'
        ? '待确认'
        : DEICE_FINAL_STATUS
  const updated: EntryRow = {
    ...stamped,
    status: target,
    pending: target !== DEICE_FINAL_STATUS,
    abnormal: false,
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  // 明细先落库，再由明细整体派生台账（按任务编号一条只对应一条用量），
  // 所以「确认完成」只重算一次、台账只认明细，重复确认不可能把喷洒量加第二遍。
  saveRows(DEICE_KEY, nextRows)
  if (action === '确认完成') {
    saveCollection(LEDGER_COLLECTION_KEY, buildDeiceLedger(nextRows))
  }
  // 落库后立刻按明细再对齐一次台账，保证后续步骤读到的就是刚写进去的状态。
  getDeiceLedger()
  return { ok: true, message: `除冰任务已${action}，当前状态「${target}」` }
}

/** 重置除冰示例数据时，台账一并回到种子口径，避免明细与台账对不上。 */
export function resetDeice(): PageResult {
  resetRows(DEICE_KEY)
  resetCollection(LEDGER_COLLECTION_KEY)
  getDeiceLedger()
  return listDeiceJobs()
}
