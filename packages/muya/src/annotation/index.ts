import type Content from '../block/base/content';
import type TreeNode from '../block/base/treeNode';
import type { TBlockPath } from '../block/types';
import type { IHighlight } from '../inlineRenderer/types';
import type { Muya } from '../muya';
import type { Nullable } from '../types';
import type {
    IAnnotation,
    IAnnotationExportItem,
    IAnnotationInspection,
    IAnnotationRange,
    IAnnotationReveal,
    IAnnotationRevealOptions,
    TAnnotationChangeType,
    TRevealStatus,
    TSelectionSnapshot,
} from './types';
import { getLongUniqueId } from '../utils';
import {
    caretPointOf,
    computeLineNumbers,
    extractAnchor,
    isFragmentQuote,
    orderAnnotationsByDocument,
    pathKey,
    rangesContainOffset,
    rangesContainSelection,
    relocateAnnotation,
    selectionToRanges,
} from './anchor';
import { DocIndex } from './docIndex';
import { normalizePhraseList } from './quickPhrase';
import { bridgeRange, captureSnapshot, findReplacementBlock, isQuoteRemoved } from './snapshot';
import { ANNOTATION_CLASS_NAMES } from './types';

/** `json-change` 后的重定位节流窗口（方案 §2.3）。 */
const RELOCATE_DEBOUNCE = 400;

/** 历史定位的闪烁时长（ms），与 `.mu-annotation-flash` 动画时长一致。 */
const FLASH_DURATION = 3600;

/**
 * 画「整块闪烁」时向上穿过的内层容器：代码块 / 公式 / HTML / 图表的内容块外面
 * 还包着一层只负责排版的容器，框要画在真正的块（`pre` / figure）上。
 */
const OUTLINE_PASSTHROUGH = new Set(['code', 'html-container', 'math-container', 'diagram-container']);
const LIST_ITEMS = new Set(['list-item', 'task-list-item']);

interface IBlockHighlightEntry {
    path: TBlockPath;
    highlights: IHighlight[];
}

/**
 * 一条条目最近一次检视的结果（只在内存里，不落盘）。
 *
 * 命中条件：同一棵块树、条目锚点没变（对象引用 + 区间指纹）、归档态没变，且
 *   - 文档版本（`jsonState.revision`）没变 → 直接复用；
 *   - 文档变了但结果是 `located`，并且「现在」所在的顶层块 state 仍是同一个
 *     对象（json1 只浅拷贝被编辑的容器，没被动过的子树引用不变）→ 仍然复用。
 *     这样正文别处打字时，已定位的历史条目不必重新全文检索。
 */
interface IInspectCacheEntry {
    revision: number;
    scrollPage: unknown;
    anchor: IAnnotation['anchor'];
    rangesKey: string;
    archived: boolean;
    result: IAnnotationInspection;
    witness: Nullable<Array<{ top: number; ref: unknown }>>;
}

const NO_HIGHLIGHTS: IHighlight[] = [];

/**
 * 检视用的条目副本：只复制会被重定位改写的字段（区间、状态、当前文本），
 * 历史检视因此**不再回写归档条目的锚点**——「现在」只是读出来的，不该把打字中途
 * 的模糊命中、或重复文本里挑错的那一处写进盘里。
 */
function probeOf(annotation: IAnnotation): IAnnotation {
    return {
        ...annotation,
        anchor: {
            ...annotation.anchor,
            ranges: annotation.anchor.ranges.map(range => ({ ...range, blockPath: [...range.blockPath] })),
        },
    };
}

/** 从 `highlights` 里挖掉 `holes` 覆盖的部分（闪烁段压过同处的其它高亮）。 */
function carveHighlights(highlights: IHighlight[], holes: Array<{ start: number; end: number }>): IHighlight[] {
    let out = highlights;
    for (const hole of holes) {
        const next: IHighlight[] = [];
        for (const light of out) {
            if (light.type === 'annotation-flash' || light.end <= hole.start || light.start >= hole.end) {
                next.push(light);
                continue;
            }
            const hasLeft = light.start < hole.start;
            if (hasLeft)
                next.push({ ...light, end: hole.start });
            if (light.end > hole.end) {
                // 序号角标只留在最前面那一段。
                const data = hasLeft && light.data ? { ...light.data, index: undefined } : light.data;
                next.push({ ...light, start: hole.end, data });
            }
        }
        out = next;
    }
    return out;
}

/**
 * 标注模块（对标 `src/search/index.ts` 的模块形态）：持有标注表、由选区快照
 * 生成锚点、四段式重定位、给行内渲染器提供高亮、导出结构化数据并广播
 * `annotation-change`。
 *
 * 只认「主文档」：所有查询都走当前 `scrollPage`，块引用一律不缓存（外部重载
 * 后块对象整棵换新，缓存引用必然失效）。
 */
export class AnnotationModule {
    private _annotations: IAnnotation[] = [];
    private _enabled = true;
    /** 常用语列表（应用级偏好，不进标注存储结构；卡片 chips 的唯一数据源）。 */
    private _quickPhrases: string[] = [];
    private _activeId: Nullable<string> = null;
    private _relocateTimer: Nullable<ReturnType<typeof setTimeout>> = null;
    /** 因「光标所在块」被跳过的条目，等 blur / 光标离开后补做。 */
    private _deferred = new Set<string>();
    private _cache: Nullable<Map<string, IBlockHighlightEntry>> = null;
    /**
     * 卡片打开期间「正在标注的选区」——画成选中态，卡片一关就清（用户拍板）。
     * 走高亮通道而不是直接改 DOM：卡片抢焦点后原生选区就没了，而高亮是引擎
     * 自己的渲染层，块重渲染也稳。
     */
    private _pendingRanges: IAnnotationRange[] = [];
    /** 历史定位的闪烁段（一次性，到时自动清掉；不进标注表、不落盘）。 */
    private _flashRanges: IAnnotationRange[] = [];
    private _flashTimer: Nullable<ReturnType<typeof setTimeout>> = null;
    private _flashBlockEl: Nullable<HTMLElement> = null;
    /** 历史检视结果缓存（见 `IInspectCacheEntry`）。 */
    private _inspectCache = new Map<string, IInspectCacheEntry>();
    /** 同一版本文档共用的检索索引（见 docIndex.ts）。 */
    private _index: Nullable<DocIndex> = null;
    private _indexRevision = -1;

    constructor(private _muya: Muya) {
        const { eventCenter } = _muya;
        eventCenter.subscribe('json-change', () => {
            // 正文一改，闪烁段的偏移就可能对不上了：直接收掉，不画在错字上。
            if (this._flashRanges.length || this._flashBlockEl)
                this._clearFlash();
            this._scheduleRelocate();
        });
        eventCenter.subscribe('content-change', () => this._scheduleRelocate());
        // 光标离开被跳过的块时补做（方案 §2.3：blur / 选区离开该块两个时机都要）。
        // 只在确实有被跳过的条目时才跑，避免每次移动光标都做一遍重定位。
        eventCenter.subscribe('selection-change', () => {
            if (this._deferred.size)
                this._runRelocate();
        });
        eventCenter.subscribe('blur', () => this._flushDeferred());
        // 工具条「标注」按钮的桥接事件：命中已有标注 → 该条进入激活态（卡片编辑态）。
        eventCenter.subscribe('muya-annotation-request', (snapshot: TSelectionSnapshot) => {
            if (!snapshot || !this.findAtSnapshot(snapshot))
                this.setActive(null);
        });
    }

    /** 偏好开关（`annotationEnabled`）。false → 不画高亮。 */
    get enabled() {
        return this._enabled;
    }

    /** 常用语列表（原样副本，外部改动不影响模块内部状态）。 */
    get quickPhrases(): string[] {
        return [...this._quickPhrases];
    }

    /**
     * 整表替换常用语并广播 `annotation-quick-phrases-change`：卡片开着时就地刷新
     * chips。与标注数据无关（应用级偏好，不进存储结构、不触发重定位）。
     */
    /**
     * 常用语整表替换（应用级数据，桌面偏好是唯一写方）。
     *
     * 逐条规范化 + 去重 + 按上限截断；与当前内容完全一致时不广播——`pushToEngine`
     * 在归档 / 复制 / 切文档时都会推一次，不判等会让开着的卡片无谓地整张重渲染。
     */
    setQuickPhrases(list: string[]) {
        const next = normalizePhraseList(list);
        if (
            next.length === this._quickPhrases.length
            && next.every((phrase, index) => phrase === this._quickPhrases[index])
        ) {
            return;
        }

        this._quickPhrases = next;
        this._muya.eventCenter.emit('annotation-quick-phrases-change', this.quickPhrases);
    }

    /** 当前激活条 id（卡片编辑中 / 面板定位），无激活为 null。 */
    get activeId(): Nullable<string> {
        return this._activeId;
    }

    /**
     * 全表快照（含已归档条目），按**文档顺序**返回（失效条目排最后）。
     *
     * 顺序与 `getExport()`、正文角标序号同源：桌面 `refreshIndexById` 是按
     * 「位置对齐」把 `list()` 的条目与 `getExport()` 的 `index` 配起来的，三处
     * 口径必须一致，否则面板序号会指到别的标注上。
     */
    list(): IAnnotation[] {
        return orderAnnotationsByDocument([...this._annotations], this._muya);
    }

    /**
     * 偏好开关；关闭时立刻擦掉正文高亮（数据保留），重新打开时按当前表重画。
     */
    setEnabled(value: boolean) {
        const next = !!value;
        if (next === this._enabled)
            return;

        // 关掉时按「当前画着的」擦，打开时要按「表里可画的」重画——打开方向的
        // `_highlightedPaths()` 是空的（禁用期间缓存就是空表），拿它会把
        // 「重新打开」变成什么都不做。
        const paths = next ? this._paintablePaths() : this._highlightedPaths();
        this._enabled = next;
        this._invalidate();
        this._repaint(paths);
    }

    /**
     * 设置当前激活条（面板定位、卡片编辑态）。高亮样式随之切到 `annotation-active`。
     * 不在契约冻结的 API 列表内，但方案 §3.3 的「当前激活标注」态与 §3.4 的定位
     * 动作需要它——契约未覆盖，取最小实现。
     */
    setActive(id: Nullable<string>) {
        const next = id ?? null;
        if (next === this._activeId)
            return;

        const paths = this._highlightedPaths();
        this._activeId = next;
        this._invalidate();
        this._repaint(paths);
    }

    /**
     * 新一条**全局备注**：不锚定正文内容（`ranges` 为空，正文不画高亮、不参与
     * 重定位），用于「对整篇文档」的总体意见——复制文本里它显示为「全局备注」。
     * 备注 trim 后为空返回 null（空备注不允许保存）。
     */
    addGlobal(note: string): IAnnotation | null {
        const text = (note ?? '').trim();
        if (!text)
            return null;

        const now = Date.now();
        const annotation: IAnnotation = {
            id: getLongUniqueId(),
            anchor: {
                ranges: [],
                quote: '',
                prefix: '',
                suffix: '',
                blockText: '',
                beforeBlockText: '',
                afterBlockText: '',
                blockPath: [],
                headingPath: [],
            },
            note: text,
            global: true,
            copied: false,
            archived: false,
            anchorState: 'anchored',
            createdAt: now,
            updatedAt: now,
        };

        this._annotations.push(annotation);
        this._invalidate();
        this._emitChange('add', annotation.id);
        return annotation;
    }

    /**
     * 由选区快照新建一条标注。备注 trim 后为空、选区为空或块解析失败时返回 null
     * （空备注不允许保存，引擎侧同样兜住）。
     */
    addFromSnapshot(snapshot: TSelectionSnapshot, note: string): IAnnotation | null {
        const text = (note ?? '').trim();
        if (!text)
            return null;

        const ranges = selectionToRanges(snapshot);
        if (!ranges.length)
            return null;

        const anchor = extractAnchor(ranges, this._muya);
        if (!anchor)
            return null;

        const now = Date.now();
        // 标注时的样子（历史对比的「标注时」）：拍不到快照不影响新建，
        // 历史里会按 v2 字段反推一张近似快照。
        let origin: IAnnotation['origin'];
        try {
            origin = captureSnapshot(anchor.ranges, this._muya, { capturedAt: now }) ?? undefined;
        }
        catch {
            origin = undefined;
        }
        const annotation: IAnnotation = {
            id: getLongUniqueId(),
            anchor,
            note: text,
            copied: false,
            archived: false,
            anchorState: 'anchored',
            currentText: anchor.quote,
            ...(origin ? { origin } : {}),
            createdAt: now,
            updatedAt: now,
        };

        this._mutate('add', annotation.id, () => {
            this._annotations.push(annotation);
        });

        return annotation;
    }

    /** 编辑备注；trim 后为空或内容未变时不动。 */
    /**
     * 编辑备注；返回是否「可以视为保存成功」。条目已不存在（在面板里被删掉）
     * 或文本为空时返回 false——卡片据此不退场、亮失败提示，而不是静默收场、
     * 让用户刚写的字消失。文本与现值相同算成功（用户只是确认了一下）。
     */
    updateNote(id: string, note: string): boolean {
        const annotation = this._find(id);
        const text = (note ?? '').trim();
        if (!annotation || !text)
            return false;
        if (annotation.note === text)
            return true;

        this._mutate('update', id, () => {
            annotation.note = text;
            annotation.updatedAt = Date.now();
        });

        return true;
    }

    /** 删除条目。 */
    remove(id: string) {
        const index = this._annotations.findIndex(annotation => annotation.id === id);
        if (index < 0)
            return;

        if (this._activeId === id)
            this._activeId = null;
        this._deferred.delete(id);

        this._mutate('remove', id, () => {
            this._annotations.splice(index, 1);
        });
    }

    /**
     * 选区完全落在某条已有标注内 → 返回该条（卡片开编辑态）并把它设为激活条；
     * 否则返回 null（新建态）。
     *
     * 折叠光标（点正文高亮那一类）也算命中——否则 §3.2「点正文高亮直接开备注卡片」
     * 这条路径会落回新建态。
     */
    findAtSnapshot(snapshot: TSelectionSnapshot): IAnnotation | null {
        const selection = selectionToRanges(snapshot);
        const caret = selection.length ? null : caretPointOf(snapshot);

        if (!selection.length && !caret)
            return null;

        for (const annotation of this._annotations) {
            if (annotation.archived || annotation.anchorState === 'orphaned')
                continue;

            const hit = caret
                ? rangesContainOffset(annotation.anchor.ranges, caret.blockPath, caret.offset)
                : rangesContainSelection(annotation.anchor.ranges, selection);

            if (hit) {
                this.setActive(annotation.id);
                return annotation;
            }
        }

        return null;
    }

    /**
     * 切换文档 / 外部载入：整表替换 + 全量重定位（四段式）+ 全量重画。
     */
    setAnnotations(list: IAnnotation[]) {
        const before = this._highlightedPaths();
        this._annotations = Array.isArray(list) ? [...list] : [];
        this._activeId = null;
        this._deferred.clear();
        const ids = new Set(this._annotations.map(annotation => annotation.id));
        for (const id of [...this._inspectCache.keys()]) {
            if (!ids.has(id))
                this._inspectCache.delete(id);
        }
        this._relocateAll();
        this._invalidate();
        this._repaint([...before, ...this._highlightedPaths()]);
        this._emitChange('view');
    }

    /**
     * 全量重定位 + 核对（外部重载后由宿主调用）。`json-change` 之后的 debounce
     * 路径也会跑到这里，宿主不调用也能自愈。
     */
    relocate() {
        const before = this._highlightedPaths();
        const changed = this._relocateAll();
        this._invalidate();
        if (changed) {
            this._repaint([...before, ...this._highlightedPaths()]);
            this._emitChange('relocate');
        }
    }

    /**
     * 导出结构化数据（引擎出数据、桌面出文案）。`ids` 省略 = 当前表里所有未归档
     * 条目；返回按文档顺序排列，失效条目排最后，`index` 是**返回数组内**的 1-based
     * 序号（与复制文本的 `[1] [2]` 一一对应）。
     */
    getExport(ids?: string[]): IAnnotationExportItem[] {
        const pool = ids?.length
            ? ids.map(id => this._find(id)).filter((item): item is IAnnotation => !!item)
            : this._annotations.filter(annotation => !annotation.archived);

        const ordered = orderAnnotationsByDocument(pool, this._muya);
        const lines = computeLineNumbers(ordered, this._muya);

        return ordered.map((annotation, index) => {
            const line = lines.get(annotation.id);

            return {
                id: annotation.id,
                index: index + 1,
                headingPath: [...annotation.anchor.headingPath],
                lineStart: line?.start,
                lineEnd: line?.end,
                quote: annotation.anchor.quote,
                blockText: annotation.anchor.blockText,
                note: annotation.note,
                orphaned: annotation.anchorState === 'orphaned',
                fragment: isFragmentQuote(annotation, this._muya),
                global: !!annotation.global,
            };
        });
    }

    /**
     * 给还没有「标注时」快照的条目补拍一张（旧版本建的、尚未复制的条目在复制
     * 那一刻补）。只在锚点仍**原样命中**（当前文本 === 引文）时补——文字已经被改过
     * 的话，此刻的样子已经不是标注时的样子，宁可留空走 v2 反推。返回补拍条数。
     */
    ensureOrigins(ids: string[]): number {
        let count = 0;

        for (const id of ids ?? []) {
            const annotation = this._find(id);
            if (!annotation || annotation.origin || annotation.global)
                continue;
            if (annotation.anchorState === 'orphaned' || annotation.currentText !== annotation.anchor.quote)
                continue;

            try {
                const origin = captureSnapshot(annotation.anchor.ranges, this._muya);
                if (origin) {
                    annotation.origin = origin;
                    count++;
                }
            }
            catch {
                // 拍不到就算了：历史里走 v2 反推，不影响复制。
            }
        }

        return count;
    }

    /**
     * 历史对比的「现在」（feat/annotation-history-compare）。
     *
     * 归档条目不参与打字时的增量重定位，所以这里对它们的**副本**按四段式重定位
     * 一遍，拿到它们此刻的位置，再拍一张「现在」的快照：
     *   - 锚点命中（含移动、模糊命中）→ `located`，快照画出命中的那一段，`ranges`
     *     是这一段现在的区间（历史「定位」用）；
     *   - 引文找不到、但原段落按邻接块 / 相似度还能对上 → `block`（整句被改写），
     *     快照是那个段落、不画区间，`blockPath` 指向它；
     *   - 都找不到 → `missing`（原文已删除）；段落还在、只是这一句被删掉时也是
     *     `missing`，但附带该段落的快照与 `blockPath` 供面板展示语境、供定位。
     *
     * 只读：**不改写**条目锚点、不广播、不触发落盘（第一轮会把检视结果写回归档
     * 锚点并落盘，打字中途的模糊命中会把原始落点永久替换掉）。
     *
     * 成本：同一版本文档共用一份检索索引（docIndex.ts）；结果按条目缓存，文档
     * 没变直接复用，变了的话已定位且所在顶层块没被编辑的条目也复用。全局备注
     * 不在返回值里。
     */
    inspect(ids?: string[]): IAnnotationInspection[] {
        const pool = ids?.length
            ? ids.map(id => this._find(id)).filter((item): item is IAnnotation => !!item)
            : this._annotations.filter(annotation => annotation.archived);

        this._flushState();
        const results: IAnnotationInspection[] = [];

        for (const annotation of pool) {
            if (annotation.global)
                continue;
            results.push(this._inspectCached(annotation));
        }

        return results;
    }

    /**
     * 在正文里定位一条标注**现在**的位置（历史条目点击定位）：滚到那里，并用
     * 一次性的闪烁标出来（几秒后自动消失；不移动光标、不改标注表、不落盘）。
     *
     * 位置的口径与 `inspect()` 完全一致（同一份缓存）：命中 → 闪烁那一段；整句
     * 改写 / 这一句被删 → 闪烁原来的段落；连段落也没了 → 退到原来的相邻段落
     * （原位置附近）；都找不到 → `none`，不滚动，由宿主给出明确提示。
     */
    reveal(id: string, options: IAnnotationRevealOptions = {}): IAnnotationReveal {
        const annotation = this._find(id);
        if (!annotation)
            return { id, status: 'none', inspection: null };
        if (annotation.global)
            return { id, status: 'global', inspection: null };

        this._flushState();
        let inspection: Nullable<IAnnotationInspection> = null;
        try {
            inspection = this._inspectCached(annotation);
        }
        catch {
            inspection = null;
        }

        const target = this._revealTarget(annotation, inspection);
        if (!target) {
            this._clearFlash();
            return { id, status: 'none', inspection };
        }

        const shown = this._showFlash(target.ranges, target.blockPath, options);

        return { id, status: shown ? target.status : 'none', inspection };
    }

    /** 宿主侧手动收掉闪烁（例如切换文档）。 */
    clearReveal() {
        this._clearFlash();
    }

    private _revealTarget(
        annotation: IAnnotation,
        inspection: Nullable<IAnnotationInspection>,
    ): Nullable<{ status: TRevealStatus; ranges: IAnnotationRange[]; blockPath: TBlockPath }> {
        const live = (path: Nullable<TBlockPath> | undefined) =>
            !!path && !!this._contentAt(path);

        if (inspection?.match === 'located' && inspection.ranges?.length && inspection.ranges.every(range => live(range.blockPath)))
            return { status: 'range', ranges: inspection.ranges, blockPath: inspection.ranges[0]!.blockPath };
        if (inspection?.match === 'block' && live(inspection.blockPath))
            return { status: 'block', ranges: [], blockPath: inspection.blockPath! };
        if (inspection?.match === 'missing' && live(inspection.blockPath))
            return { status: 'context', ranges: [], blockPath: inspection.blockPath! };

        const near = this._nearPath(annotation);
        if (near)
            return { status: 'near', ranges: [], blockPath: near };

        return null;
    }

    /**
     * 原文连同所在段落都没了：按锚点里记下的前 / 后邻接块文本找回「原来的位置」。
     * 优先找「前邻居的下一块正好是后邻居」的那一处（原段落夹在两者之间被删掉）；
     * 否则前邻居或后邻居在全文唯一时取它。找不到 / 有歧义返回 null。
     */
    private _nearPath(annotation: IAnnotation): Nullable<TBlockPath> {
        const { beforeBlockText, afterBlockText } = annotation.anchor;
        const index = this._docIndex();
        if (!index || (!beforeBlockText && !afterBlockText))
            return null;

        const startsWith = (text: Nullable<string> | undefined, probe: string) =>
            text != null && !!probe && text.slice(0, probe.length) === probe;
        const entries = index.blocks.filter(entry => entry.block.blockName !== 'language-input');
        const befores = beforeBlockText ? entries.filter(entry => startsWith(entry.block.text, beforeBlockText)) : [];
        const afters = afterBlockText ? entries.filter(entry => startsWith(entry.block.text, afterBlockText)) : [];

        for (const entry of befores) {
            const { next } = index.neighbors(entry);
            if (afterBlockText ? startsWith(next, afterBlockText) : next == null)
                return [...entry.block.path];
        }
        for (const entry of afters) {
            const { previous } = index.neighbors(entry);
            if (!beforeBlockText && previous == null)
                return [...entry.block.path];
        }
        if (befores.length === 1)
            return [...befores[0]!.block.path];
        if (afters.length === 1)
            return [...afters[0]!.block.path];

        return null;
    }

    private _contentAt(path: TBlockPath): Nullable<Content> {
        const block = this._muya.editor.scrollPage?.queryBlock([...path]);
        return block && block.isContent() ? block : null;
    }

    /** 闪烁：区间段走高亮通道，找不到渲染出来的段（代码块等不走行内渲染）或只有块时画整块框。 */
    private _showFlash(ranges: IAnnotationRange[], blockPath: TBlockPath, options: IAnnotationRevealOptions): boolean {
        this._clearFlash();

        const block = this._contentAt(blockPath);
        if (!block)
            return false;

        const flashable = ranges.filter(range => range.end > range.start);
        if (flashable.length) {
            const before = this._highlightedPaths();
            this._flashRanges = flashable.map(range => ({ ...range, blockPath: [...range.blockPath] }));
            this._invalidate();
            this._repaint([...before, ...this._highlightedPaths()]);
        }

        let spot: Nullable<Element> = flashable.length
            ? (block.domNode?.querySelector(`.${ANNOTATION_CLASS_NAMES.MU_ANNOTATION_FLASH}`) ?? null)
            : null;

        if (!spot) {
            const host = this._outlineHost(block);
            if (host) {
                host.classList.add(ANNOTATION_CLASS_NAMES.MU_ANNOTATION_FLASH_BLOCK);
                this._flashBlockEl = host;
                spot = host;
            }
        }

        if (!spot)
            return false;

        if (typeof (spot as HTMLElement).scrollIntoView === 'function')
            (spot as HTMLElement).scrollIntoView({ block: 'center', behavior: options.smooth === false ? 'auto' : 'smooth' });

        this._flashTimer = setTimeout(() => {
            this._flashTimer = null;
            this._clearFlash();
        }, options.duration ?? FLASH_DURATION);

        return true;
    }

    private _outlineHost(block: Content): Nullable<HTMLElement> {
        let node: Nullable<TreeNode> = block.parent ?? block;
        while (node && OUTLINE_PASSTHROUGH.has(node.blockName) && node.parent)
            node = node.parent;
        // 列表项里的段落：框画在整条列表项上（把序号 / 圆点也框进去，不从中间切开）。
        if (node?.blockName === 'paragraph' && node.parent && LIST_ITEMS.has(node.parent.blockName))
            node = node.parent;
        return (node?.domNode ?? block.domNode ?? null) as Nullable<HTMLElement>;
    }

    private _clearFlash() {
        if (this._flashTimer) {
            clearTimeout(this._flashTimer);
            this._flashTimer = null;
        }
        if (this._flashBlockEl) {
            this._flashBlockEl.classList.remove(ANNOTATION_CLASS_NAMES.MU_ANNOTATION_FLASH_BLOCK);
            this._flashBlockEl = null;
        }
        if (this._flashRanges.length) {
            const before = this._highlightedPaths();
            this._flashRanges = [];
            this._invalidate();
            this._repaint(before);
        }
    }

    /** 把还没并进 state 的编辑（rAF 批量）先落进去：检视读 state，块树与 state 要一致。 */
    private _flushState() {
        try {
            this._muya.editor.jsonState?.flush();
        }
        catch {
            // flush 失败时 state 自己会重建；检视按当前块树继续。
        }
    }

    private _docIndex(): Nullable<DocIndex> {
        const { scrollPage, jsonState } = this._muya.editor;
        if (!scrollPage)
            return null;
        const revision = jsonState?.revision ?? -1;
        if (!this._index || this._index.scrollPage !== scrollPage || this._indexRevision !== revision) {
            this._index = new DocIndex(scrollPage);
            this._indexRevision = revision;
        }
        return this._index;
    }

    private _inspectCached(annotation: IAnnotation): IAnnotationInspection {
        const { scrollPage, jsonState } = this._muya.editor;
        const revision = jsonState?.revision ?? -1;
        const rangesKey = JSON.stringify(annotation.anchor.ranges);
        const archived = !!annotation.archived;
        const cached = this._inspectCache.get(annotation.id);

        if (
            cached
            && cached.scrollPage === scrollPage
            && cached.anchor === annotation.anchor
            && cached.rangesKey === rangesKey
            && cached.archived === archived
        ) {
            if (cached.revision === revision)
                return cached.result;
            if (cached.witness && this._witnessHolds(cached.witness)) {
                cached.revision = revision;
                return cached.result;
            }
        }

        const result = this._inspectFresh(annotation);
        this._inspectCache.set(annotation.id, {
            revision,
            scrollPage,
            anchor: annotation.anchor,
            rangesKey,
            archived,
            result,
            witness: result.match === 'located' && result.ranges?.length ? this._witnessOf(result.ranges) : null,
        });

        return result;
    }

    private _inspectFresh(annotation: IAnnotation): IAnnotationInspection {
        const index = this._docIndex() ?? undefined;
        let subject = annotation;
        if (annotation.archived) {
            subject = probeOf(annotation);
            relocateAnnotation(subject, this._muya, index);
        }
        return this._inspectOne(subject, index);
    }

    private _witnessOf(ranges: IAnnotationRange[]): Nullable<Array<{ top: number; ref: unknown }>> {
        const state = this._muya.editor.jsonState?.getStateRef();
        if (!state)
            return null;
        const tops = [...new Set(ranges.map(range => range.blockPath[0]))];
        if (tops.some(top => typeof top !== 'number' || !state[top]))
            return null;
        return tops.map(top => ({ top: top as number, ref: state[top as number] }));
    }

    private _witnessHolds(witness: Array<{ top: number; ref: unknown }>): boolean {
        const state = this._muya.editor.jsonState?.getStateRef();
        return !!state && witness.every(({ top, ref }) => state[top] === ref);
    }

    private _inspectOne(annotation: IAnnotation, index?: DocIndex): IAnnotationInspection {
        const { id } = annotation;
        const { quote, blockText, prefix, suffix, ranges } = annotation.anchor;
        const single = ranges.length <= 1 && !quote.includes('\n');
        // 标的本来就是整块（表格单元格、整条列表项、整个标题…）
        const whole = single && quote.trim() === (blockText ?? '').trim();

        try {
            if (annotation.anchorState !== 'orphaned') {
                const nowRanges = this._refineNowRanges(annotation, whole);
                const snapshot = captureSnapshot(nowRanges, this._muya);
                if (snapshot)
                    return { id, match: 'located', snapshot, ranges: nowRanges.map(range => ({ ...range, blockPath: [...range.blockPath] })) };
            }

            const block = findReplacementBlock(annotation, this._muya, index);
            if (block) {
                // 整块标注：对应到的块就是它现在的样子，按命中处理并整块画区间；
                // 只标了块里一部分的，先试着用原引文的前后文把「现在的那一段」夹出来，
                // 夹不出来才是「原句已改写、这是原段落」。
                // 夹出来的是**空区间**（段首 / 段尾那句被删、前后文在块边界上照样
                // 命中）不算夹到：那是删除，不是改写成空串。
                const raw = single && !whole ? bridgeRange(block.text, prefix, suffix) : null;
                const bridged = raw && raw.end > raw.start ? raw : null;
                const range = bridged ?? { start: 0, end: block.text.length };
                const path = [...block.path];
                const nowRange: IAnnotationRange = { blockPath: path, blockName: block.blockName, ...range };
                const snapshot = captureSnapshot([nowRange], this._muya, { mark: whole || !!bridged });
                if (snapshot) {
                    if (whole || bridged)
                        return { id, match: 'located', snapshot, ranges: [{ ...nowRange, blockPath: [...path] }] };
                    // 段落还在、但这一句被删掉了：判删除，同时带上所在段落给面板做语境。
                    return {
                        id,
                        match: isQuoteRemoved(annotation, block.text) ? 'missing' : 'block',
                        snapshot,
                        blockPath: path,
                    };
                }
            }
        }
        catch {
            // 快照失败（块树竞态）按「找不到」处理，面板仍能显示标注时的样子。
        }

        return { id, match: 'missing', snapshot: null };
    }

    /**
     * 「现在」该画哪一段：锚点原样命中就用锚点；被模糊匹配挪过的（文字改过），
     * 模糊窗口只是与原引文等长的近似区间，会把改长 / 改短的文字切掉一截——
     * 整块标注取整块，局部标注用前后文夹取（与模糊区间有交集才采信）。
     * 只影响历史里的展示，不回写锚点。
     */
    private _refineNowRanges(annotation: IAnnotation, whole: boolean): IAnnotationRange[] {
        const { ranges, quote, prefix, suffix } = annotation.anchor;
        if (ranges.length !== 1 || annotation.currentText === quote)
            return ranges;

        const range = ranges[0]!;
        const block = this._muya.editor.scrollPage?.queryBlock([...range.blockPath]);
        if (!block || !block.isContent())
            return ranges;

        if (whole)
            return [{ ...range, start: 0, end: block.text.length }];

        const bridged = bridgeRange(block.text, prefix, suffix);
        if (bridged && bridged.start <= range.end && bridged.end >= range.start)
            return [{ ...range, ...bridged }];

        return ranges;
    }

    /**
     * 设置「正在标注的选区」（卡片打开期间）：这些 range 会以选中态底色画出来，
     * 传空数组即清除。卡片在 `_open` / `hide` 两侧调用。
     */
    setPendingRanges(ranges: IAnnotationRange[]) {
        const next = Array.isArray(ranges) ? ranges : [];
        const same
            = next.length === this._pendingRanges.length
                && next.every((range, index) => {
                    const prev = this._pendingRanges[index]!;

                    return (
                        pathKey(range.blockPath) === pathKey(prev.blockPath)
                        && range.start === prev.start
                        && range.end === prev.end
                    );
                });

        if (same)
            return;

        const before = this._highlightedPaths();
        this._pendingRanges = next;
        this._invalidate();
        this._repaint([...before, ...this._highlightedPaths()]);
    }

    /**
     * 行内渲染器取的标注高亮（`InlineRenderer.patch` 的唯一入口）。
     * 偏好关闭、条目已归档 / 已失效时不返回任何高亮。
     */
    highlightsFor(block: Content): IHighlight[] {
        if (!this._enabled && !this._flashRanges.length)
            return NO_HIGHLIGHTS;

        // 块（或其祖先）正在销毁时 `parent` 链会在**中途**断开：`path` getter 抛
        // `Cannot destructure property 'path' of 'this.parent'`。`block.parent`
        // 只是第一环——实测崩点更深（内容块还在、它所在的容器已被置空，堆栈是
        // `get path → get path → highlightsFor`，经 `Muya.focus → setCursor →
        // blurHandler → update → patch` 触发）。所以除了快速检查，取值整段兜住。
        if (!block.parent)
            return NO_HIGHLIGHTS;

        // 卡片打开期间即使一条标注都没有（新建第一张卡片），pending 选区也要画；
        // 历史定位的闪烁段同理（它指向的是归档条目，表里可能没有一条在画）。
        if (!this._annotations.length && !this._pendingRanges.length && !this._flashRanges.length)
            return NO_HIGHLIGHTS;

        try {
            return this._highlightMap().get(pathKey(block.path))?.highlights ?? NO_HIGHLIGHTS;
        }
        catch {
            // 路径链断裂 = 该块正在销毁：不画高亮，也不把异常抛回渲染循环
            return NO_HIGHLIGHTS;
        }
    }

    /** 宿主销毁编辑器时释放定时器（事件订阅由 EventCenter.unsubscribeAll 清）。 */
    destroy() {
        if (this._relocateTimer) {
            clearTimeout(this._relocateTimer);
            this._relocateTimer = null;
        }
        if (this._flashTimer) {
            clearTimeout(this._flashTimer);
            this._flashTimer = null;
        }
        this._flashRanges = [];
        this._flashBlockEl = null;
        this._inspectCache.clear();
        this._index = null;
        this._deferred.clear();
        this._cache = null;
    }

    private _find(id: string): Nullable<IAnnotation> {
        return this._annotations.find(annotation => annotation.id === id);
    }

    private _emitChange(type: TAnnotationChangeType, id?: string) {
        this._muya.eventCenter.emit('annotation-change', { type, id });
    }

    private _invalidate() {
        this._cache = null;
    }

    /** 变更前取旧路径、变更后取新路径，两侧都重画（高亮搬家的两块都要更新）。 */
    private _mutate(type: TAnnotationChangeType, id: Nullable<string>, fn: () => void) {
        const before = this._highlightedPaths();
        fn();
        this._invalidate();
        this._repaint([...before, ...this._highlightedPaths()]);
        this._emitChange(type, id ?? undefined);
    }

    private _highlightedPaths(): TBlockPath[] {
        return [...this._highlightMap().values()].map(entry => entry.path);
    }

    /** 表里「本应画高亮」的块路径（与 `enabled` 无关，供开关打开方向重画）。 */
    private _paintablePaths(): TBlockPath[] {
        const paths: TBlockPath[] = [];

        for (const annotation of this._annotations) {
            if (annotation.archived || annotation.anchorState === 'orphaned')
                continue;
            for (const range of annotation.anchor.ranges)
                paths.push(range.blockPath);
        }

        return paths;
    }

    /** 路径 → 该块的高亮（惰性重建，任何表 / 开关 / 激活态变化都会失效）。 */
    private _highlightMap(): Map<string, IBlockHighlightEntry> {
        if (this._cache)
            return this._cache;

        const cache = new Map<string, IBlockHighlightEntry>();

        if (this._enabled && (this._annotations.length || this._pendingRanges.length)) {
            const indexes = this._indexMap();

            for (const annotation of this._annotations) {
                if (annotation.archived || annotation.anchorState === 'orphaned')
                    continue;

                const type = annotation.id === this._activeId ? 'annotation-active' : 'annotation';

                annotation.anchor.ranges.forEach((range, index) => {
                    const key = pathKey(range.blockPath);
                    let entry = cache.get(key);
                    if (!entry) {
                        entry = { path: [...range.blockPath], highlights: [] };
                        cache.set(key, entry);
                    }
                    entry.highlights.push({
                        start: range.start,
                        end: range.end,
                        active: false,
                        type,
                        data: {
                            // 角标只画在首段（跨块标注只在首块出序号）。
                            index: index === 0 ? indexes.get(annotation.id) : undefined,
                            copied: annotation.copied,
                            note: annotation.note,
                        },
                    });
                });
            }

            // 正在标注的选区（卡片打开期间）：与标注高亮同走一条渲染通道，
            // 只是样式换成选中态（`.mu-annotation-pending`）。
            for (const range of this._pendingRanges) {
                const key = pathKey(range.blockPath);
                let entry = cache.get(key);

                if (!entry) {
                    entry = { path: [...range.blockPath], highlights: [] };
                    cache.set(key, entry);
                }

                entry.highlights.push({
                    start: range.start,
                    end: range.end,
                    active: false,
                    type: 'annotation-pending',
                    data: {},
                });
            }
        }

        // 历史定位的闪烁段：与「高亮开关」无关（用户是在面板里主动点的定位），
        // 并且压过同处的其它高亮——重叠部分从别的高亮里挖掉，否则行内渲染按起点
        // 先到先得，闪烁段会被更早开始的标注吃掉一截。
        for (const range of this._flashRanges) {
            const key = pathKey(range.blockPath);
            let entry = cache.get(key);
            if (!entry) {
                entry = { path: [...range.blockPath], highlights: [] };
                cache.set(key, entry);
            }
            entry.highlights = carveHighlights(entry.highlights, [range]);
            entry.highlights.push({
                start: range.start,
                end: range.end,
                active: false,
                type: 'annotation-flash',
                data: {},
            });
        }

        for (const entry of cache.values())
            entry.highlights.sort((a, b) => a.start - b.start || a.end - b.end);

        this._cache = cache;

        return cache;
    }

    /** id → 序号（未归档条目按文档顺序，失效排最后；与面板/复制文本口径一致）。 */
    private _indexMap(): Map<string, number> {
        const ordered = orderAnnotationsByDocument(
            this._annotations.filter(annotation => !annotation.archived),
            this._muya,
        );

        return new Map(ordered.map((annotation, index) => [annotation.id, index + 1]));
    }

    /**
     * 重画若干块。光标所在块走 `setCursor(..., true)`（引擎既有的 `_forceRender`
     * 手法），避免重渲染后丢光标。
     */
    private _repaint(paths: Iterable<TBlockPath>) {
        const { scrollPage, selection } = this._muya.editor;
        if (!scrollPage)
            return;

        const live = selection.getSelection();
        const seen = new Set<string>();

        for (const path of paths) {
            const key = pathKey(path);
            if (seen.has(key))
                continue;
            seen.add(key);

            const block = scrollPage.queryBlock([...path]);
            if (!block || !block.isContent())
                continue;

            if (live && live.anchor.block === block) {
                const begin = Math.min(live.anchor.offset, live.focus.offset);
                const end = Math.max(live.anchor.offset, live.focus.offset);
                block.setCursor(begin, end, true);
            }
            else {
                block.update();
            }
        }
    }

    /** 当前光标所在块（编辑中才有值；失焦为 null → 不做跳过）。 */
    private _caretPathKey(): Nullable<string> {
        const block = this._muya.editor.activeContentBlock;
        if (!block)
            return null;
        try {
            return pathKey(block.path);
        }
        catch {
            // 与 highlightsFor 同因：外部重载/切标签的竞态里，块还在但祖先链
            // 中途断开，`path` getter 抛 `Cannot destructure property 'path' of
            // 'this.parent'`（2026-10-08 实测：重载后的增量重定位在此崩溃）。
            // 取不到路径只是没法跳过光标块，按不跳过继续，异常不能抛回渲染循环。
            return null;
        }
    }

    private _touchesPath(annotation: IAnnotation, key: string): boolean {
        return annotation.anchor.ranges.some(range => pathKey(range.blockPath) === key);
    }

    private _scheduleRelocate() {
        if (this._relocateTimer)
            clearTimeout(this._relocateTimer);

        this._relocateTimer = setTimeout(() => {
            this._relocateTimer = null;
            this._runRelocate();
        }, RELOCATE_DEBOUNCE);
    }

    /**
     * 增量重定位：跳过光标所在块（打字时不让高亮跳），其余立即重做；
     * 被跳过的进 `_deferred`，blur 或下一次光标移开后补做。
     */
    private _runRelocate() {
        if (!this._annotations.length)
            return;

        const caretKey = this._caretPathKey();
        const before = this._highlightedPaths();
        let changed = false;

        for (const annotation of this._annotations) {
            if (annotation.archived || annotation.global)
                continue;
            if (caretKey && this._touchesPath(annotation, caretKey)) {
                this._deferred.add(annotation.id);
                continue;
            }
            changed = this._relocateOne(annotation) || changed;
        }

        this._invalidate();

        if (changed) {
            this._repaint([...before, ...this._highlightedPaths()]);
            this._emitChange('relocate');
        }
    }

    /** 光标离开被跳过的块（blur / 选区移开）时补做。 */
    private _flushDeferred() {
        if (!this._deferred.size)
            return;

        const ids = [...this._deferred];
        this._deferred.clear();
        const before = this._highlightedPaths();
        let changed = false;

        for (const id of ids) {
            const annotation = this._find(id);
            if (annotation)
                changed = this._relocateOne(annotation) || changed;
        }

        this._invalidate();

        if (changed) {
            this._repaint([...before, ...this._highlightedPaths()]);
            this._emitChange('relocate');
        }
    }

    private _relocateAll(): boolean {
        let changed = false;

        for (const annotation of this._annotations) {
            // 全局备注没有正文锚点，重定位无意义（也不该被标成 orphaned）。
            if (annotation.global)
                continue;
            changed = this._relocateOne(annotation) || changed;
        }

        return changed;
    }

    /** 单条重定位，返回「锚点是否有实质变化」（决定要不要重画与广播）。 */
    private _relocateOne(annotation: IAnnotation): boolean {
        this._deferred.delete(annotation.id);
        const before = serializeAnchorState(annotation);
        relocateAnnotation(annotation, this._muya);

        return serializeAnchorState(annotation) !== before;
    }
}

/** 锚点状态的廉价指纹，用于判断重定位是否真的改动了什么。 */
function serializeAnchorState(annotation: IAnnotation): string {
    const { anchorState, currentText, contentChanged, anchor } = annotation;

    return `${anchorState}|${currentText ?? ''}|${String(contentChanged)}|${JSON.stringify(anchor.ranges)}`;
}

declare module '../editor/index' {
    // 增补的是既有 `Editor` 类的实例成员，名字由目标类固定，不适用 `I` 前缀规则。
    // eslint-disable-next-line ts/naming-convention
    interface Editor {
        /**
         * 标注模块。与 `muya.annotation` 是**同一个实例**——方案 §5.8 的工具条代码
         * 写的是 `muya.editor.annotation`，这里给它一个真实落点，避免两处各自
         * new 出一个模块（重复订阅 + 状态分叉）。
         */
        annotation: AnnotationModule;
    }
}
