import { describe, expect, it, vi } from 'vitest'

// `@/store/annotation` 会连带拉起 renderer 侧的一串模块（@/config 在模块加载期
// 读 `window.path.sep`、通知服务会摸 DOM）。这里只测纯函数，按既有惯例
// （test/unit/specs/editor-store-anchor.spec.ts）先把这些表面打桩。
vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: { sep: string; dirname: (p: string) => string }
      electron?: {
        clipboard: { writeText: (s: string) => void }
        ipcRenderer: { send: (...a: unknown[]) => void; on: (...a: unknown[]) => void }
      }
    }
  }
  w.window ??= {}
  w.window.path ??= { sep: '/', dirname: (p: string) => p }
  w.window.electron ??= {
    clipboard: { writeText: () => {} },
    ipcRenderer: { send: () => {}, on: () => {} }
  }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))

import { buildCopyText, fenceFor } from '@/store/annotation'
import type { IAnnotationExportItem } from '@shared/types/ipc'

/**
 * 复制文本模板（方案 §4.1 / §4.4）的纯函数单测。
 *
 * 最关键的两条：① 抬头必须是「【文档标注】」；② **全文不含任何「轮」字样**
 * ——轮次是墨记内部的记账，写进给 agent 的指令既无助于定位，还会和「对话里
 * 的第几轮」混淆（方案 §4.3 已明确）。
 */

const DOC_PATH = '/Users/ashuang/Documents/PRD-MoMark-一期二期.md'

const item = (patch: Partial<IAnnotationExportItem> = {}): IAnnotationExportItem => ({
  index: 1,
  headingPath: ['第三章 需求说明', '3.2 权限模型'],
  lineStart: 128,
  lineEnd: 130,
  quote: '用户可以在任意页面切换角色。',
  blockText: '3.2.2 角色切换：用户可以在任意页面切换角色。',
  note: '这段逻辑不通。',
  orphaned: false,
  fragment: false,
  ...patch
})

describe('buildCopyText — 抬头', () => {
  it('首行是【文档标注】，并给出文件绝对路径与条目数', () => {
    const text = buildCopyText([item(), item({ index: 2 })], DOC_PATH)
    const lines = text.split('\n')

    expect(lines[0]).toBe('【文档标注】')
    expect(lines[1]).toBe(`文件：${DOC_PATH}`)
    expect(lines[2]).toBe('共 2 条')
  })

  it('抬头句声明「行号基于复制时的版本」，抑制 agent 盲信行号', () => {
    const text = buildCopyText([item()], DOC_PATH)
    expect(text).toContain('行号基于复制时的版本')
    // 精简：指令句式一律不出现（用户拍板），只留信息性声明。
    expect(text).not.toContain('只改被标注的位置')
    expect(text).not.toContain('请按下述')
    expect(text).toContain('定位以「原文」为准')
  })

  it('条目数只算正文条目，失效条目由附录那句单独交代', () => {
    const text = buildCopyText([item(), item({ index: 2, orphaned: true })], DOC_PATH)
    expect(text).toContain('共 1 条')
    expect(text).toContain('（另有 1 条标注的原文已不存在，见文末附录，请判断是否已被你处理）')
  })
})

describe('buildCopyText — 全文不含「轮」字样', () => {
  it('普通条目 + 失效条目 + 多行备注都不出现轮次', () => {
    const text = buildCopyText(
      [
        item({ note: '第一行\n第二行' }),
        item({ index: 2, quote: '表格里要补字段', blockText: '| 字段 | 类型 |' }),
        item({ index: 3, orphaned: true })
      ],
      DOC_PATH
    )
    expect(text).not.toContain('轮')
  })

  it('也不出现标注 id、时间戳与应用名（方案 §4.4.6）', () => {
    const text = buildCopyText([item()], DOC_PATH)
    expect(text).not.toContain('墨记')
    expect(text).not.toContain('ann-1')
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })
})

describe('buildCopyText — 围栏长度自适应（方案 §4.4.1）', () => {
  it('普通内容用三个反引号', () => {
    expect(fenceFor('普通文本')).toBe('```')
  })

  it('内容里出现三连反引号 → 升到四个，绝不硬用三个', () => {
    const quote = '```js\nconst a = 1\n```'
    expect(fenceFor(quote)).toBe('````')

    const text = buildCopyText([item({ quote })], DOC_PATH)
    expect(text).toContain('````text')
    expect(text).toContain('````')
    // 「```text」这种被三反引号围住再撞上四反引号的行不可能出现
    expect(text.split('\n').filter((line) => line === '````text').length).toBe(1)
  })

  it('超长反引号串同样按最长串 + 1 计算', () => {
    expect(fenceFor('`````')).toBe('``````')
  })
})

describe('buildCopyText — 截断（方案 §4.4.4）', () => {
  it('引文 > 500 字：首 240 + 省略说明 + 末 240，并补「完整范围」行', () => {
    const quote = `${'A'.repeat(300)}${'B'.repeat(300)}`
    const text = buildCopyText([item({ quote, lineStart: 10, lineEnd: 20 })], DOC_PATH)

    expect(quote.length).toBe(600)
    expect(text).toContain('…（中间省略 120 字）…')
    expect(text).toContain('A'.repeat(240))
    expect(text).toContain('B'.repeat(240))
    expect(text).toContain('完整范围：L10–L20（共 11 行）')
  })

  it('未超长时不出现省略说明与完整范围行', () => {
    const text = buildCopyText([item()], DOC_PATH)
    expect(text).not.toContain('中间省略')
    expect(text).not.toContain('完整范围')
  })

  it('所在段落 > 300 字：首 150 + … + 末 150', () => {
    const blockText = `${'x'.repeat(400)}`
    const text = buildCopyText([item({ blockText })], DOC_PATH)
    expect(text).toContain(`${'x'.repeat(150)}…${'x'.repeat(150)}`)
    expect(text).not.toContain('x'.repeat(151))
  })
})

describe('buildCopyText — 失效附录（方案 §4.1）', () => {
  it('失效条目走文末附录，编号用 [A] [B]', () => {
    const text = buildCopyText(
      [item(), item({ index: 2, orphaned: true }), item({ index: 3, orphaned: true })],
      DOC_PATH
    )
    expect(text).toContain('附录：原文已删除的标注（请判断是否已处理，若已处理请忽略）')
    expect(text).toContain('[A] 第三章 需求说明 › 3.2 权限模型 ｜ 原引文：')
    expect(text).toContain('[B] 第三章 需求说明 › 3.2 权限模型 ｜ 原引文：')
    // 附录条目不再出现「所在段落」
    const appendix = text.slice(text.indexOf('附录：'))
    expect(appendix).not.toContain('所在段落：')
  })

  it('没有失效条目时整段附录不出现', () => {
    const text = buildCopyText([item()], DOC_PATH)
    expect(text).not.toContain('附录')
    expect(text).not.toContain('原文已删除')
  })
})

describe('buildCopyText — 章节 / 行号 / 所在段落', () => {
  it('章节路径用 › 连接，行号跟在后面', () => {
    const text = buildCopyText([item()], DOC_PATH)
    expect(text).toContain('[1] 第三章 需求说明 › 3.2 权限模型 ｜ L128–L130')
  })

  it('缺章节时退化为「（未记录章节）」，缺行号时整段省略', () => {
    const text = buildCopyText(
      [item({ headingPath: [], lineStart: undefined, lineEnd: undefined })],
      DOC_PATH
    )
    expect(text).toContain('[1] （未记录章节）')
    expect(text).not.toContain('L128')
  })

  it('选区恰好等于整段时省略「所在段落」（方案 §4.3）', () => {
    const quote = '一整段'
    const text = buildCopyText([item({ quote, blockText: quote })], DOC_PATH)
    expect(text).not.toContain('所在段落：')
  })

  it('引文切断行内标记时补一行「引文为片段」', () => {
    const text = buildCopyText([item({ fragment: true })], DOC_PATH)
    expect(text).toContain('引文为片段，请以所在段落定位。')
  })

  it('多行备注原样保留，不做任何加工（方案 §4.4.5）', () => {
    const text = buildCopyText([item({ note: '第一行\n  缩进的第二行' })], DOC_PATH)
    expect(text).toContain('修改要求：第一行\n  缩进的第二行')
  })
})
