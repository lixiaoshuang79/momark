import { describe, expect, it } from 'vitest';
import { HTML_FILE_EXT_REG, resolveClipboardPath } from '../paste';

// `resolveClipboardPath` 是「粘贴 html 文件」分流的第一跳：把应用侧
// `clipboardFilePath` 钩子（macOS 读 NSFilenamesPboardType 的一次主进程 IPC）解析成
// 原始文件路径，扩展名分流交给调用方（`pasteSelection` 用 HTML_FILE_EXT_REG 判 html，
// 图片分支用 IMAGE_EXT_REG 判图片）。这里钉住的就是「原样透传 + 异常向上抛」。

describe('resolveClipboardPath', () => {
    it('钩子不存在时返回空串', async () => {
        expect(await resolveClipboardPath(undefined)).toBe('');
    });

    it('原样返回钩子给出的路径（不按扩展名过滤，由调用方分流）', async () => {
        const hook = () => Promise.resolve('/tmp/demo/图表.html');

        expect(await resolveClipboardPath(hook)).toBe('/tmp/demo/图表.html');
        // 图片路径同样 —— 过滤发生在调用方，这里不越权。
        expect(await resolveClipboardPath(() => Promise.resolve('/tmp/shot.png'))).toBe('/tmp/shot.png');
    });

    it('钩子返回非字符串时返回空串', async () => {
        const hook = (() => Promise.resolve(undefined)) as unknown as () => Promise<string>;

        expect(await resolveClipboardPath(hook)).toBe('');
    });

    it('钩子报错时向上抛，由调用方决定降级', async () => {
        const hook = () => Promise.reject(new Error('no clipboard'));

        await expect(resolveClipboardPath(hook)).rejects.toThrow('no clipboard');
    });
});

describe('HTML_FILE_EXT_REG', () => {
    it('认 .html / .htm / 大小写混写', () => {
        expect(HTML_FILE_EXT_REG.test('/tmp/a.html')).toBe(true);
        expect(HTML_FILE_EXT_REG.test('/tmp/a.htm')).toBe(true);
        expect(HTML_FILE_EXT_REG.test('/tmp/图表.HTML')).toBe(true);
    });

    it('不认其它扩展名，也不认后缀里嵌 html 的名字', () => {
        for (const p of ['/tmp/a.png', '/tmp/a.md', '', '/tmp/html.md', '/tmp/a.html.bak', '/tmp/a.htmlx'])
            expect(HTML_FILE_EXT_REG.test(p)).toBe(false);
    });
});
