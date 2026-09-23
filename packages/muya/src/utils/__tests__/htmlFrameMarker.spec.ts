import type { IHtmlFrameMeta } from '../../state/types';
import { describe, expect, it } from 'vitest';
import { buildFrameMarker, stripFrameMarker } from '../htmlFrameMarker';

// 内嵌 HTML 块的外框尺寸落盘格式：`<!--momark-frame w=960 h=436 z=1-->`。
// 这组用例锁住两件事：① 注释行的字面格式（改格式会让老文档读不出尺寸）；
// ② 摘标记的行为（标记绝不能漏进渲染内容，老文档必须原样返回）。
describe('buildFrameMarker — 序列化标记行', () => {
    it('按 w / h / z 顺序写出三个键', () => {
        expect(buildFrameMarker({ width: 960, height: 436, zoom: 1 })).toBe('<!--momark-frame w=960 h=436 z=1-->');
    });

    it('只写有值的键', () => {
        expect(buildFrameMarker({ width: 960 })).toBe('<!--momark-frame w=960-->');
        expect(buildFrameMarker({ height: 436 })).toBe('<!--momark-frame h=436-->');
        expect(buildFrameMarker({ zoom: 1.5 })).toBe('<!--momark-frame z=1.5-->');
    });

    it('宽高取整，缩放保留两位以内小数', () => {
        expect(buildFrameMarker({ width: 960.4, height: 436.6 })).toBe('<!--momark-frame w=960 h=437-->');
        expect(buildFrameMarker({ zoom: 1.234 })).toBe('<!--momark-frame z=1.23-->');
        expect(buildFrameMarker({ zoom: 1 / 3 })).toBe('<!--momark-frame z=0.33-->');
    });

    it('没有有效数值时不写标记（宁可整行不写，也不写空壳）', () => {
        expect(buildFrameMarker(undefined)).toBe('');
        expect(buildFrameMarker({})).toBe('');
        expect(buildFrameMarker({ width: Number.NaN, height: Number.POSITIVE_INFINITY })).toBe('');
    });
});

describe('stripFrameMarker — 解析标记行', () => {
    it('摘掉标记行并解析出 meta', () => {
        const { text, meta } = stripFrameMarker('<!--momark-frame w=960 h=436 z=1-->\n<div>hi</div>');

        expect(text).toBe('<div>hi</div>');
        expect(meta).toEqual({ width: 960, height: 436, zoom: 1 } satisfies IHtmlFrameMeta);
    });

    it('标记独占一个 token 时（解析器会把注释与 HTML 拆开）剩下空文本', () => {
        expect(stripFrameMarker('<!--momark-frame w=960 h=436 z=1-->')).toEqual({
            text: '',
            meta: { width: 960, height: 436, zoom: 1 },
        });
    });

    it('没有标记时原样返回，meta 缺席（老文档零影响）', () => {
        expect(stripFrameMarker('<div>hi</div>')).toEqual({ text: '<div>hi</div>' });
        expect(stripFrameMarker('<!-- 普通注释 -->\n<div>hi</div>')).toEqual({
            text: '<!-- 普通注释 -->\n<div>hi</div>',
        });
    });

    it('只认第一行：正文里的同类注释不参与解析', () => {
        const source = '<div>hi</div>\n<!--momark-frame w=960-->';
        expect(stripFrameMarker(source)).toEqual({ text: source });
    });

    it('无法识别的键被忽略，但标记行照样摘掉', () => {
        expect(stripFrameMarker('<!--momark-frame w=960 x=1-->\n<b>a</b>')).toEqual({
            text: '<b>a</b>',
            meta: { width: 960 },
        });
        expect(stripFrameMarker('<!--momark-frame x=1-->\n<b>a</b>')).toEqual({ text: '<b>a</b>' });
    });

    it('标记行两侧的空白不影响识别（列表/块引用里会带缩进）', () => {
        expect(stripFrameMarker('  <!--momark-frame w=800-->  \n  <div>a</div>')).toEqual({
            text: '  <div>a</div>',
            meta: { width: 800 },
        });
    });
});
