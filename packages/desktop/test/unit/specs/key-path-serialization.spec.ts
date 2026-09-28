import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// P2「按键同步路径瘦身」的**形状守卫**。这条路径（engine `json-change` → store
// 内容管线）每按一次键就跑一遍，所以它只允许做「必须同步」的事；开销大的派生量
// 与回灌比较都必须挪走。行为断言在别处（`engine-own-write-marker.spec.ts`、
// `buffered-state-dirty-only.spec.ts`、`source-mode-commit-debounce.spec.ts`），
// 这里钉住 editor.vue 里这三件事不被改回去：
//
//   1. 一次 `json-change` 只序列化一次 markdown，且不再深拷贝块树（`getState()`）、
//      不再同步算 TOC / 字数；
//   2. 左右双开同步 watch 先走「引擎自写标记」快路径，字符串兜底比较在其后；
//   3. 滚动监听经 rAF 合并。
//
// 这些断言读真实源码，每次运行重新读取，不会与实现漂移（同
// `source-code-image-action.spec.ts` 的做法）。

const here = dirname(fileURLToPath(import.meta.url))
const editorVue = resolve(here, '../../../src/renderer/src/components/editorWithTabs/editor.vue')

const source = readFileSync(editorVue, 'utf8')
const lines = source.split('\n')

const regionBetween = (startNeedle: string, endNeedle: string): string => {
  const start = lines.findIndex((l) => l.includes(startNeedle))
  expect(start, `找不到起点：${startNeedle}`).toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && l.includes(endNeedle))
  expect(end, `找不到终点：${endNeedle}`).toBeGreaterThan(start)
  return lines.slice(start, end + 1).join('\n')
}

const countMatches = (text: string, re: RegExp): number => (text.match(re) ?? []).length

describe('editor.vue key path — no per-keystroke full serialization / deep clone (P2)', () => {
  it('the json-change handler serializes markdown exactly once and drops getState/getTOC/word count', () => {
    const handler = regionBetween("editor.value.on('json-change'", 'scheduleDerivedStats(id)')

    // 只数真实调用（`editor.value.getMarkdown(`），注释里提到的字样不算。
    expect(countMatches(handler, /editor\.value\.getMarkdown\s*\(/g)).toBe(1)
    expect(handler).not.toMatch(/\.getState\s*\(/)
    expect(handler).not.toMatch(/getTOC\s*\(/)
    expect(handler).not.toMatch(/muyaWordCount\s*\(/)
    // 来源标记（`fromEngine`，store 侧据此记下「引擎自己写的」）与派生量的空闲
    // 调度都挂在这里。
    expect(handler).toMatch(/fromEngine:\s*true/)
    expect(handler).toMatch(/scheduleDerivedStats\s*\(/)
  })

  it('never deep-clones the block tree anywhere in editor.vue', () => {
    // 旧写法是 `blocks: editor.value.getState()`：整篇块树深拷贝，store 从不读。
    expect(source).not.toMatch(/\.getState\s*\(/)
  })

  it('the left/right sync watch checks the engine own-write mark BEFORE the string fallback', () => {
    const marker = source.indexOf('editorStore.IS_ENGINE_OWN_WRITE(tab.id, md)')
    const fallback = source.indexOf('adjustTrailingNewlines(md, opt) === adjustTrailingNewlines(')

    expect(marker).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(-1)
    // 标记命中即返回，昂贵的 `getMarkdown()` 兜底比较只在其后。
    expect(marker).toBeLessThan(fallback)
  })

  it('coalesces scroll events into one store write per frame', () => {
    const handler = regionBetween('scrollHandler = () => {', "container.addEventListener('scroll'")

    expect(handler).toMatch(/requestAnimationFrame\s*\(/)
    expect(handler).toMatch(/updateScrollPosition\s*\(/)
  })
})
