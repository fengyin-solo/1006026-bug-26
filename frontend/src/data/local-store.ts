import { DEICE_KEY, DEICE_LEDGER_KEY, buildFluidLedger, normalizeDeiceRow } from './deice'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 重算收口：除冰行无论谁读、谁写，都先过 data/deice.ts 的同一套重算，
// 明细、汇总、台账、导出看到的作业时长与用量因此一定是同一个数。
function normalizeForKey(key: string, rows: EntryRow[]): EntryRow[] {
  return key === DEICE_KEY ? rows.map(normalizeDeiceRow) : rows
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  if (key === DEICE_LEDGER_KEY) {
    const stored = allRows()[DEICE_LEDGER_KEY]
    if (stored) {
      return stored
    }
    // 老数据还没有台账：按当前除冰明细现算一份顶上，规则与落库的那份完全相同。
    return buildFluidLedger(normalizeForKey(DEICE_KEY, allRows()[DEICE_KEY] ?? []))
  }
  return normalizeForKey(key, allRows()[key] ?? [])
}

export function saveRows(key: string, rows: EntryRow[]): void {
  let next = { ...allRows(), [key]: normalizeForKey(key, rows) }
  if (key === DEICE_KEY) {
    // 重算结果回写除冰液需求台账：台账由已完成任务整体重建、随除冰明细一起落库，
    // 不做增量累加，重复写入也不会把用量加两遍；保障资源调度读到的就是这份。
    next = { ...next, [DEICE_LEDGER_KEY]: buildFluidLedger(next[DEICE_KEY]) }
  }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
