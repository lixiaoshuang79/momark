<template>
  <article class="hc-item" :class="`is-${item.status}`">
    <header class="hc-top">
      <span v-if="sentIndex" class="hc-idx" :title="t('annotation.compare.indexTitle')"
        >[{{ sentIndex }}]</span
      >
      <span class="hc-status" :class="item.status"><i class="dot" />{{ statusText }}</span>
      <span v-for="facet in facets" :key="facet" class="hc-facet">{{ facet }}</span>
    </header>
    <div v-if="pathText" class="hc-path" :title="pathText">
      {{ pathText }}
    </div>
    <div class="hc-note">
      {{ annotation.note }}
    </div>

    <div v-if="item.status !== 'global'" class="hc-cmp" :class="{ two: !single }">
      <section class="hc-pane before">
        <div class="hc-label">
          <span>{{ single ? t('annotation.compare.same') : t('annotation.compare.before') }}</span>
          <span v-if="beforeKind" class="hc-kind">{{ beforeKind }}</span>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -- renderSnapshotHtml 输出经 DOMPurify 清洗 -->
        <div
          v-if="beforeHtml"
          ref="beforeBox"
          class="hc-render"
          @click="blockLinks"
          v-html="beforeHtml"
        />
        <div v-else class="hc-render plain">
          {{ annotation.anchor.quote }}
        </div>
        <div v-if="item.origin?.legacy" class="hc-sub">
          {{ t('annotation.compare.legacy') }}
        </div>
      </section>

      <section v-if="!single" class="hc-pane now">
        <div class="hc-label">
          <span>{{
            item.match === 'block' ? t('annotation.compare.nowBlock') : t('annotation.compare.now')
          }}</span>
          <span v-if="nowKind" class="hc-kind" :class="{ changed: item.comparison?.block }">{{
            nowKind
          }}</span>
        </div>
        <template v-if="item.status === 'deleted'">
          <div class="hc-render gone">
            {{
              nowHtml ? t('annotation.compare.deletedInBlock') : t('annotation.compare.deletedBody')
            }}
          </div>
          <!-- 段落还在、只是这一句没了：附上现在的段落做语境 -->
          <!-- eslint-disable-next-line vue/no-v-html -- renderSnapshotHtml 输出经 DOMPurify 清洗 -->
          <div v-if="nowHtml" class="hc-render context" @click="blockLinks" v-html="nowHtml" />
        </template>
        <div v-else-if="!nowHtml" class="hc-render gone">
          {{ t('annotation.compare.pending') }}
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -- renderSnapshotHtml 输出经 DOMPurify 清洗 -->
        <div v-else ref="nowBox" class="hc-render" @click="blockLinks" v-html="nowHtml" />
      </section>
    </div>

    <div v-if="diffSegments.length" class="hc-diff">
      <span class="hc-diff-label">{{ t('annotation.compare.diff') }}</span>
      <span
        v-for="(segment, index) in diffSegments"
        :key="index"
        :class="segment.op === -1 ? 'del' : segment.op === 1 ? 'ins' : 'eq'"
        >{{ segment.text }}</span
      >
    </div>

    <footer class="hc-foot">
      <button class="mini" @click.stop="store.restore(annotation.id)">
        {{ t('annotation.action.restore') }}
      </button>
      <button class="mini danger" @click.stop="store.deleteArchived([annotation.id])">
        {{ t('annotation.action.delete') }}
      </button>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { t } from '../../i18n'
import { useAnnotationStore, type HistoryCompareItem } from '@/store/annotation'
import type { IAnnotationSnapshot } from '@shared/types/ipc'
import { renderSnapshotHtml } from '@muyajs/core/annotation/snapshotRender'
import { compactDiff, snapshotKindLabel } from './annotationHistoryFormat'

/**
 * 历史里的一条标注：「标注时」与「现在」对照（feat/annotation-history-compare）。
 *
 * - 两侧都是真实渲染出来的块（标题级别、列表、表格行、引用、代码块、行内格式），
 *   标注段用 `<mark>` 圈出；
 * - 顶部状态条：已修改 / 未改动 / 整句改写 / 原文已删除，外加「文字 / 格式 /
 *   块类型 H2 → H3」这样的维度标签——不用逐字比对就知道改了什么；
 * - 未改动时只出一栏（标注时 = 现在），省地方也一眼可辨；
 * - 文字有改动时底部给逐字差异（删除划线、新增底色）。
 */

const props = defineProps<{ item: HistoryCompareItem }>()

const store = useAnnotationStore()
const annotation = computed(() => props.item.annotation)
const sentIndex = computed(() =>
  typeof annotation.value.sentIndex === 'number' ? annotation.value.sentIndex : null
)
const single = computed(() => props.item.status === 'unchanged')
const pathText = computed(() => (annotation.value.anchor.headingPath ?? []).join(' › '))

const statusText = computed(() => t(`annotation.compare.status.${props.item.status}`))

const beforeKind = computed(() => snapshotKindLabel(props.item.origin))
const nowKind = computed(() => (single.value ? '' : snapshotKindLabel(props.item.now)))

const facets = computed<string[]>(() => {
  const comparison = props.item.comparison
  if (!comparison) return []
  const list: string[] = []
  if (comparison.status === 'changed' && comparison.text) {
    list.push(t('annotation.compare.facet.text'))
  }
  if (comparison.format) list.push(t('annotation.compare.facet.format'))
  if (comparison.block) {
    const from = beforeKind.value || snapshotKindLabel(props.item.origin, true)
    const to = snapshotKindLabel(props.item.now, true)
    if (from && to) list.push(t('annotation.compare.facet.block', { from, to }))
  }
  if (comparison.context) list.push(t('annotation.compare.facet.context'))
  return list
})

const diffSegments = computed(() => compactDiff(props.item.comparison?.diff ?? null))

// ── 渲染（同一份 markdown 只渲染一次：历史里最多 500 条，切视图不重复解析）──
const HTML_CACHE_MAX = 600
const htmlCache = new Map<string, string>()

const renderCached = (snapshot: IAnnotationSnapshot | null): string => {
  if (!snapshot?.markdown) return ''
  const key = `${snapshot.kind}:${snapshot.markStart}:${snapshot.markEnd}:${snapshot.markdown}`
  const hit = htmlCache.get(key)
  if (hit !== undefined) return hit
  let html = ''
  try {
    html = renderSnapshotHtml(snapshot)
  } catch (error) {
    console.error('[annotation] Failed to render snapshot.', error)
  }
  if (htmlCache.size >= HTML_CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value as string)
  htmlCache.set(key, html)
  return html
}

const beforeHtml = computed(() => renderCached(props.item.origin))
const nowHtml = computed(() => renderCached(props.item.now))

/** 快照里的链接只是外观，点了不能把整个窗口导航走。 */
const blockLinks = (event: MouseEvent): void => {
  if ((event.target as Element | null)?.closest?.('a')) event.preventDefault()
}

// 内容超出框高时，把标注段滚进可视区（长段落 / 长代码块里 mark 可能在后半截）。
const beforeBox = ref<HTMLElement | null>(null)
const nowBox = ref<HTMLElement | null>(null)
const revealMark = (box: HTMLElement | null): void => {
  if (!box || box.scrollHeight <= box.clientHeight) return
  const mark = box.querySelector('mark') as HTMLElement | null
  if (mark) box.scrollTop = Math.max(0, mark.offsetTop - 24)
}
const revealAll = (): void => {
  nextTick(() => {
    revealMark(beforeBox.value)
    revealMark(nowBox.value)
  })
}
onMounted(revealAll)
watch([beforeHtml, nowHtml], revealAll)
</script>

<style scoped>
.hc-item {
  padding: 10px 12px 10px 26px;
}
.hc-item + .hc-item {
  border-top: 1px solid var(--line);
}
.hc-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-bottom: 4px;
  font-size: 11px;
  line-height: 18px;
}
.hc-idx {
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
.hc-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 500;
  color: var(--muted);
}
.hc-status .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--faint);
}
.hc-status.changed,
.hc-status.rewritten {
  color: var(--ink);
}
.hc-status.changed .dot,
.hc-status.rewritten .dot {
  background: var(--success);
}
.hc-status.unchanged .dot {
  background: var(--warn);
}
.hc-status.deleted {
  color: var(--danger);
}
.hc-status.deleted .dot {
  background: var(--danger);
}
.hc-status.global .dot {
  background: var(--accent);
}
.hc-facet {
  padding: 0 6px;
  border-radius: 4px;
  color: var(--muted);
  background: var(--hover);
  white-space: nowrap;
}
.hc-path {
  font-size: 11px;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 2px;
}
.hc-note {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--muted);
  margin-bottom: 7px;
}
/* ── 对照区：窄栏上下叠放，宽栏（≥ 460px）左右并排 ── */
.hc-cmp {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
  margin-bottom: 6px;
}
@container ann-list (min-width: 460px) {
  .hc-cmp.two {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}
.hc-pane {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  overflow: hidden;
  background: var(--surface-2);
}
.hc-pane.now {
  border-color: color-mix(in oklab, var(--accent) 28%, var(--line));
}
.is-deleted .hc-pane.now {
  border-style: dashed;
  border-color: var(--line-strong);
  background: transparent;
}
.hc-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 10.5px;
  color: var(--faint);
  border-bottom: 1px solid var(--line);
  background: var(--hover);
}
.hc-kind {
  margin-left: auto;
  color: var(--muted);
  white-space: nowrap;
}
.hc-kind.changed {
  color: var(--ink);
  font-weight: 500;
}
.hc-sub {
  padding: 0 8px 5px;
  font-size: 10.5px;
  color: var(--faint);
}
/* ── 渲染出来的块：缩小字号、保留层级差异 ── */
.hc-render {
  position: relative;
  max-height: 168px;
  overflow: auto;
  padding: 6px 8px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink);
  word-break: break-word;
}
.hc-render.plain {
  font: 11.5px/1.5 var(--font-mono);
  color: var(--muted);
  white-space: pre-wrap;
}
.hc-render.gone {
  color: var(--faint);
  font-size: 12px;
  font-style: italic;
}
.hc-render.gone + .hc-render.context {
  padding-top: 0;
  color: var(--muted);
}
.hc-render :deep(> :first-child) {
  margin-top: 0;
}
.hc-render :deep(> :last-child) {
  margin-bottom: 0;
}
.hc-render :deep(p) {
  margin: 0 0 4px;
}
.hc-render :deep(h1),
.hc-render :deep(h2),
.hc-render :deep(h3),
.hc-render :deep(h4),
.hc-render :deep(h5),
.hc-render :deep(h6) {
  margin: 0 0 4px;
  line-height: 1.35;
  font-weight: 600;
}
.hc-render :deep(h1) {
  font-size: 17px;
}
.hc-render :deep(h2) {
  font-size: 15.5px;
}
.hc-render :deep(h3) {
  font-size: 14px;
}
.hc-render :deep(h4) {
  font-size: 13px;
}
.hc-render :deep(h5),
.hc-render :deep(h6) {
  font-size: 12.5px;
  color: var(--muted);
}
.hc-render :deep(ul),
.hc-render :deep(ol) {
  margin: 0 0 4px;
  padding-left: 18px;
}
.hc-render :deep(li > input[type='checkbox']) {
  margin: 0 4px 0 -16px;
  vertical-align: -1px;
}
.hc-render :deep(li:has(> input[type='checkbox'])) {
  list-style: none;
}
.hc-render :deep(blockquote) {
  margin: 0 0 4px;
  padding: 0 0 0 8px;
  border-left: 3px solid var(--line-strong);
  color: var(--muted);
}
.hc-render :deep(code) {
  font: 11.5px/1.5 var(--font-mono);
  padding: 0 3px;
  border-radius: 3px;
  background: var(--hover);
}
.hc-render :deep(pre) {
  margin: 0 0 4px;
  padding: 6px 8px;
  border-radius: 5px;
  background: var(--hover);
  overflow-x: auto;
}
.hc-render :deep(pre code) {
  padding: 0;
  background: transparent;
  white-space: pre;
}
.hc-render :deep(table) {
  border-collapse: collapse;
  font-size: 11.5px;
  margin: 0 0 4px;
}
.hc-render :deep(th),
.hc-render :deep(td) {
  border: 1px solid var(--line-strong);
  padding: 2px 6px;
  text-align: left;
}
.hc-render :deep(th) {
  background: var(--hover);
  font-weight: 600;
}
.hc-render :deep(img) {
  max-width: 100%;
  max-height: 80px;
}
.hc-render :deep(a) {
  color: var(--accent);
  cursor: default;
}
.hc-render :deep(hr) {
  border: none;
  border-top: 1px solid var(--line-strong);
}
.hc-render :deep(mark.mu-snap-mark) {
  color: inherit;
  background: color-mix(in oklab, var(--accent) 22%, transparent);
  border-radius: 2px;
  box-shadow: 0 1px 0 color-mix(in oklab, var(--accent) 60%, transparent);
}
/* ── 逐字差异 ── */
.hc-diff {
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
  margin-bottom: 6px;
  word-break: break-word;
  white-space: pre-wrap;
}
.hc-diff-label {
  margin-right: 6px;
  font-size: 10.5px;
  color: var(--faint);
}
.hc-diff .del {
  color: var(--danger);
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklab, var(--danger) 70%, transparent);
  background: color-mix(in oklab, var(--danger) 10%, transparent);
}
.hc-diff .ins {
  color: var(--ink);
  background: color-mix(in oklab, var(--success) 20%, transparent);
  border-radius: 2px;
}
.hc-foot {
  display: flex;
  gap: 6px;
}
.mini {
  flex: none;
  height: 21px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  font-size: 11.5px;
  font-family: inherit;
  color: var(--muted);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  cursor: pointer;
}
.mini:hover {
  background: var(--hover);
  color: var(--ink);
}
.mini.danger:hover {
  color: var(--danger);
}
</style>
