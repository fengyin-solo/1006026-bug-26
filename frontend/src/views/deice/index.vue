<template>
  <section class="page" data-module="deice">
    <header class="page-head">
      <div>
        <h2>除冰作业管理</h2>
        <p class="page-desc">维护除冰任务，围绕任务编号、航班号、除冰液型号、喷洒量做登记、筛选与状态流转。作业时长统一按开始/结束时间重算，明细与月度用量同一口径。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记除冰任务</button>
        <button class="btn" type="button" @click="exportRows">导出除冰作业清单</button>
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
          <td v-for="column in columns" :key="column">
            <template v-if="column === '作业时长'">
              {{ row[column] }}
              <em
                v-if="durationTag(row)"
                class="duration-tag"
                :class="durationTag(row) === '按起止时间' ? 'tag-computed' : 'tag-registered'"
              >{{ durationTag(row) }}</em>
            </template>
            <template v-else>{{ row[column] === 0 ? 0 : (row[column] || '—') }}</template>
          </td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无除冰作业数据，可先登记除冰任务</td>
        </tr>
      </tbody>
    </table>

    <section class="ledger-block">
      <h3>{{ usageMonth }} 本月除冰液用量（按型号汇总）</h3>
      <p class="ledger-hint">与上方明细共用同一套重算结果，只统计「已完成」作业；重复确认完成不会重复计入。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>除冰液型号</th>
            <th>作业架次</th>
            <th>喷洒量合计（L）</th>
            <th>作业时长合计（分钟）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in usageRows" :key="item.除冰液型号">
            <td>{{ item.除冰液型号 }}</td>
            <td>{{ item.作业架次 }}</td>
            <td>{{ item.喷洒量合计 }}</td>
            <td>{{ item.作业分钟合计 }}</td>
          </tr>
          <tr v-if="!usageRows.length">
            <td colspan="4" class="empty-state">本月暂无已完成的除冰作业</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条除冰作业记录 · 本月喷洒量合计 {{ usageTotal }} L（数据已回写除冰液需求台账）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  deiceFluidUsage,
  listDeiceJobs,
  applyDeiceAction,
} from '@/api/deice-service'
import { downloadEntries } from '@/api/local-service'
import { DEICE_KEY, type DeiceJob } from '@/data/deice'
import type { EntryRow } from '@/data/types'

const columns = ["任务编号", "航班号", "除冰液型号", "喷洒量", "除冰车号", "开始时间", "结束时间", "作业时长"]
const actions = ["开始除冰", "提交确认", "确认完成"]
const statuses = ["待除冰", "除冰中", "待确认", "已完成"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const usageRows = ref<ReturnType<typeof deiceFluidUsage>['rows']>([])
const usageTotal = ref(0)
const usageMonth = ref('')

const stats = computed(() => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayPrefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const todayCount = rows.value.filter((row) => String(row['开始时间']).startsWith(todayPrefix)).length
  const inProgress = rows.value.filter((row) => String(row.status) === '除冰中').length
  return [
    { label: '今日除冰架次', value: todayCount },
    { label: '除冰中任务', value: inProgress },
    { label: '本月除冰液用量(L)', value: usageTotal.value },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 时长单元格上的口径标注：按起止时间重算 / 起止缺失时沿用登记值，冲突判定一眼可查。
function durationTag(row: EntryRow): string {
  const job = row as DeiceJob
  if (job['时长口径'] === 'computed') {
    return '按起止时间'
  }
  if (job['时长口径'] === 'registered') {
    return '沿用登记'
  }
  return ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(DEICE_KEY)
}

function openCreate() {
  errorMessage.value = '除冰任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyDeiceAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listDeiceJobs(filters.value)
    rows.value = payload.items
    total.value = payload.total
    const usage = deiceFluidUsage()
    usageRows.value = usage.rows
    usageTotal.value = usage.total
    usageMonth.value = usage.month
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '除冰作业列表读取失败'
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
.duration-tag {
  margin-left: 6px;
  font-style: normal;
  font-size: 11px;
  border-radius: 999px;
  padding: 1px 8px;
}
.tag-computed {
  background: #e7f6ec;
  color: #1a7f37;
}
.tag-registered {
  background: #fdf1e3;
  color: #b45309;
}
</style>
