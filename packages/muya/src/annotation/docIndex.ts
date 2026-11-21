import type Content from '../block/base/content';
import type TreeNode from '../block/base/treeNode';
import type { ScrollPage } from '../block/scrollPage';
import { gramCounts, gramIntersection, normalizeText, pathKey } from './anchor';

/**
 * 文档级检索索引（feat/annotation-history-compare 第二轮）。
 *
 * 历史检视要对几十到几百条归档标注逐条重定位：每条都会走「全文精确 → 全文
 * 模糊 → 段落级相似度」，原先每一段都各自把整篇文档遍历一遍、逐块重新归一化
 * 和切 2-gram——成本是 O(条数 × 文档长度) 且常数很大（实测 1200 块 / 150 条
 * 首次 8.4s）。这里把「与条目无关」的部分只做一次：内容块列表、文档序号、
 * 归一化文本和 2-gram 计数（惰性），同一版本的文档内所有条目共用。
 *
 * 只读：不持有对块树的写操作；块对象引用只在**同一文档版本**内有效，调用方
 * （`AnnotationModule`）按 `jsonState.revision` + `scrollPage` 身份决定何时重建。
 */
export interface IIndexedBlock {
    block: Content;
    key: string;
    ordinal: number;
    /** 建索引时的文本；读归一化 / 2-gram 时发现块文本变了就就地重算。 */
    text: string;
    normalized?: { text: string; map: number[] };
    grams?: Map<string, number>;
    /** 段落级比对用：块文本前 `BLOCK_COMPARE_MAX` 字的归一化文本与 2-gram。 */
    head?: { text: string; grams: Map<string, number> };
    /** 上下文中的前 / 后一个内容块文本（无则 null）。 */
    neighbors?: { previous: string | null; next: string | null };
}

/** 段落级兜底比对（原句被整句改写）：块文本参与比对的最大长度。 */
export const BLOCK_COMPARE_MAX = 2000;

export class DocIndex {
    readonly blocks: IIndexedBlock[] = [];
    private _byKey = new Map<string, IIndexedBlock>();

    constructor(readonly scrollPage: ScrollPage) {
        let ordinal = 0;
        scrollPage.depthFirstTraverse((node: TreeNode) => {
            if (!node.isContent())
                return;
            const entry: IIndexedBlock = {
                block: node,
                key: pathKey(node.path),
                ordinal: ordinal++,
                text: node.text,
            };
            this.blocks.push(entry);
            this._byKey.set(entry.key, entry);
        });
    }

    entry(key: string): IIndexedBlock | undefined {
        return this._byKey.get(key);
    }

    ordinalOf(key: string): number | undefined {
        return this._byKey.get(key)?.ordinal;
    }

    private _fresh(entry: IIndexedBlock): IIndexedBlock {
        if (entry.block.text !== entry.text) {
            entry.text = entry.block.text;
            entry.normalized = undefined;
            entry.grams = undefined;
            entry.head = undefined;
        }
        return entry;
    }

    normalized(entry: IIndexedBlock): { text: string; map: number[] } {
        this._fresh(entry);
        entry.normalized ??= normalizeText(entry.text);
        return entry.normalized;
    }

    /** 整块归一化文本的 2-gram 计数（模糊匹配的上界剪枝用）。 */
    grams(entry: IIndexedBlock): Map<string, number> {
        this._fresh(entry);
        entry.grams ??= gramCounts(this.normalized(entry).text);
        return entry.grams;
    }

    head(entry: IIndexedBlock): { text: string; grams: Map<string, number> } {
        this._fresh(entry);
        if (!entry.head) {
            const text = normalizeText(entry.text.slice(0, BLOCK_COMPARE_MAX)).text;
            entry.head = { text, grams: gramCounts(text) };
        }
        return entry.head;
    }

    neighbors(entry: IIndexedBlock): { previous: string | null; next: string | null } {
        if (!entry.neighbors) {
            const previous = entry.block.previousContentInContext();
            const next = entry.block.nextContentInContext();
            entry.neighbors = { previous: previous ? previous.text : null, next: next ? next.text : null };
        }
        return entry.neighbors;
    }
}

/**
 * 与 `diceCoefficient(a, b)` 逐分支等价，只是 2-gram 计数由调用方预先给出
 * （一篇文档的块只切一次，所有条目共用）。
 */
export function diceFromGrams(
    a: { text: string; grams: Map<string, number> },
    b: { text: string; grams: Map<string, number> },
): number {
    if (!a.text || !b.text)
        return 0;
    if (a.text.length < 2 || b.text.length < 2)
        return a.text === b.text ? 1 : 0;

    return (2 * gramIntersection(a.grams, b.grams)) / (a.text.length - 1 + b.text.length - 1);
}

/** Dice 系数只由长度决定的上界：交集不会超过较短一方的 2-gram 总数。 */
export function diceUpperBound(lengthA: number, lengthB: number): number {
    if (lengthA < 2 || lengthB < 2)
        return lengthA && lengthB ? 1 : 0;
    const a = lengthA - 1;
    const b = lengthB - 1;
    return (2 * Math.min(a, b)) / (a + b);
}
