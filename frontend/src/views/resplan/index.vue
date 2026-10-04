<template>
  <section class="page" data-module="resplan">
    <header class="page-head">
      <div>
        <h2>保障资源调度管理</h2>
        <p class="page-desc">维护资源计划，围绕计划编号、保障时段、机位需求、车辆需求做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记资源计划</button>
        <button class="btn" type="button" @click="exportRows">导出保障资源调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无保障资源调度数据，可先登记资源计划</td>
        </tr>
      </tbody>
    </table>

    <section class="ledger-block">
      <h3>除冰液需求台账（资源调度读数）</h3>
      <p class="ledger-hint">由除冰作业「确认完成」时回写，与除冰作业明细、月度用量同一重算口径，只含已完成作业。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in ledgerColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(entry, index) in ledger" :key="`${entry.任务编号}-${index}`">
            <td v-for="column in ledgerColumns" :key="column">{{ formatLedgerCell(column, entry) }}</td>
          </tr>
          <tr v-if="!ledger.length">
            <td :colspan="ledgerColumns.length" class="empty-state">暂无已完成除冰作业回写的需求台账</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条保障资源调度记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { getDeiceLedger } from '@/api/deice-service'
import type { DeiceLedgerEntry } from '@/data/deice'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('resplan')
const columns = ["计划编号", "保障时段", "机位需求", "车辆需求", "人员需求", "资源缺口", "调度人员", "计划状态"]
const actions = ["提交审核", "下发计划", "作废计划"]
const statuses = ["待编制", "待审核", "已下发", "已作废"]
const stats = [{"label": "待编制计划", "value": 0}, {"label": "已下发计划", "value": 0}, {"label": "存在缺口的计划", "value": 0}]

// 除冰液需求台账：列与除冰侧台账结构一致，读的是同一份落库数据。
const ledgerColumns = ["任务编号", "航班号", "除冰液型号", "喷洒量", "作业分钟数", "开始时间", "结束时间", "完成月份"]
const ledger = ref<DeiceLedgerEntry[]>([])

function formatLedgerCell(column: string, entry: DeiceLedgerEntry): string {
  const value = (entry as unknown as Record<string, string | number>)[column]
  if (column === '喷洒量') {
    return `${value} L`
  }
  if (column === '作业分钟数') {
    return `${value} 分钟`
  }
  return value === '' || value === undefined ? '—' : String(value)
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '资源计划登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 资源调度线读取除冰液需求台账：与除冰明细读同一份落库结果，数值不会两样。
    ledger.value = getDeiceLedger()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保障资源调度列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.ledger-block {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.ledger-block h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
.ledger-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--muted);
}
</style>
