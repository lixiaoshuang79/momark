import { describe, expect, it } from 'vitest'
import {
    ensureMarkdownExtension,
    hasMarkdownExtension,
    stripMarkdownExtension
} from 'common/filesystem/paths'

// 「保存成 xxx.md.md」这个 bug 的根：保存对话框的推荐名来自标签页文件名，而未落盘
// 标签本身就叫 `Untitled-1.md`，再无条件拼一次 `.md` 就多了一个扩展名。修法是把
// 「补扩展名」做成幂等操作，并把「剥扩展名」扩到整个 markdown 扩展名家族。

describe('ensureMarkdownExtension', () => {
    it('已经带 markdown 扩展名时原样返回，绝不叠加', () => {
        expect(ensureMarkdownExtension('Untitled-1.md')).toBe('Untitled-1.md')
        expect(ensureMarkdownExtension('报告.MD')).toBe('报告.MD')
        expect(ensureMarkdownExtension('note.markdown')).toBe('note.markdown')
        expect(ensureMarkdownExtension('note.mdx')).toBe('note.mdx')
    })

    it('没有扩展名时补 .md', () => {
        expect(ensureMarkdownExtension('Untitled')).toBe('Untitled.md')
        expect(ensureMarkdownExtension('我的笔记')).toBe('我的笔记.md')
    })

    it('对同一个名字反复调用是稳定的（幂等）', () => {
        const once = ensureMarkdownExtension('Untitled-1.md')

        expect(ensureMarkdownExtension(once)).toBe('Untitled-1.md')
        expect(ensureMarkdownExtension(ensureMarkdownExtension('a'))).toBe('a.md')
    })
})

describe('stripMarkdownExtension', () => {
    it('剥掉整个 markdown 扩展名家族，不只是 .md', () => {
        expect(stripMarkdownExtension('note.md')).toBe('note')
        expect(stripMarkdownExtension('note.markdown')).toBe('note')
        expect(stripMarkdownExtension('note.mdx')).toBe('note')
        expect(stripMarkdownExtension('note.txt')).toBe('note')
    })

    it('大小写不敏感，且只剥尾部', () => {
        expect(stripMarkdownExtension('NOTE.MD')).toBe('NOTE')
        expect(stripMarkdownExtension('a.md.bak')).toBe('a.md.bak')
        expect(stripMarkdownExtension('md')).toBe('md')
    })

    it('空值返回空串', () => {
        expect(stripMarkdownExtension('')).toBe('')
        expect(stripMarkdownExtension(undefined as unknown as string)).toBe('')
    })
})

describe('hasMarkdownExtension', () => {
    it('与上面的 helper 判定一致', () => {
        expect(hasMarkdownExtension('a.md')).toBe(true)
        expect(hasMarkdownExtension('a.md.bak')).toBe(false)
        expect(hasMarkdownExtension('a')).toBe(false)
    })
})
