import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'
// 除冰液需求台账等派生集合单独存放：key 由领域层给出，与作业明细同一份浏览器数据。
const COLLECTION_STORAGE_KEY = 'airport-ground-ops:collections'

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

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
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

let collectionCache: Record<string, unknown[]> | null = null

function readCollections(): Record<string, unknown[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(COLLECTION_STORAGE_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, unknown[]>
  } catch {
    return {}
  }
}

function allCollections(): Record<string, unknown[]> {
  if (collectionCache === null) {
    collectionCache = readCollections()
  }
  return collectionCache
}

export function listCollection<T>(key: string): T[] {
  return (allCollections()[key] ?? []) as T[]
}

export function saveCollection<T>(key: string, items: T[]): T[] {
  const next = { ...allCollections(), [key]: items }
  collectionCache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(next))
  }
  return items
}

export function resetCollection(key: string): void {
  const next = { ...allCollections() }
  delete next[key]
  collectionCache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(next))
  }
}

export function collectionStorageKey(): string {
  return COLLECTION_STORAGE_KEY
}
