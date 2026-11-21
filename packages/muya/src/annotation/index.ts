import type Content from '../block/base/content';
import type { TBlockPath } from '../block/types';
import type { IHighlight } from '../inlineRenderer/types';
import type { Muya } from '../muya';
import type { Nullable } from '../types';
import type {
    IAnnotation,
    IAnnotationExportItem,
    IAnnotationInspection,
    IAnnotationRange,
    TAnnotationChangeType,
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
import { normalizePhraseList } from './quickPhrase';
import { bridgeRange, captureSnapshot, findReplacementBlock, isQuoteRemoved } from './snapshot';

/** `json-change` 后的重定位节流窗口（方案 §2.3）。 */
const RELOCATE_DEBOUNCE = 400;

interface IBlockHighlightEntry {
    path: TBlockPath;
    highlights: IHighlight[];
}

const NO_HIGHLIGHTS: IHighlight[] = [];

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

    constructor(private _muya: Muya) {
        const { eventCenter } = _muya;
        eventCenter.subscribe('json-change', () => this._scheduleRelocate());
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
        )
            return;

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
     * 归档条目不参与增量重定位（打字时只跟踪当前列表），所以这里先把要看的归档
     * 条目按四段式重定位一遍，拿到它们此刻的位置，再给每条拍一张「现在」的快照：
     *   - 锚点命中（含移动、模糊命中）→ `located`，快照画出命中的那一段；
     *   - 引文找不到、但原段落按邻接块 / 相似度还能对上 → `block`（整句被改写），
     *     快照是那个段落、不画区间；
     *   - 都找不到 → `missing`（原文已删除）；段落还在、只是这一句被删掉时也是
     *     `missing`，但附带该段落的快照（不画区间）供面板展示语境。
     *
     * 重定位有实质变化时广播 `relocate`，桌面据此回读并落盘 `currentText` 等字段。
     * 归档条目没有正文高亮，所以不需要重画。全局备注不在返回值里。
     */
    inspect(ids?: string[]): IAnnotationInspection[] {
        const pool = ids?.length
            ? ids.map(id => this._find(id)).filter((item): item is IAnnotation => !!item)
            : this._annotations.filter(annotation => annotation.archived);

        let changed = false;
        const results: IAnnotationInspection[] = [];

        for (const annotation of pool) {
            if (annotation.global)
                continue;
            if (annotation.archived)
                changed = this._relocateOne(annotation) || changed;

            results.push(this._inspectOne(annotation));
        }

        if (changed) {
            this._invalidate();
            this._emitChange('relocate');
        }

        return results;
    }

    private _inspectOne(annotation: IAnnotation): IAnnotationInspection {
        const { id } = annotation;
        const { quote, blockText, prefix, suffix, ranges } = annotation.anchor;
        const single = ranges.length <= 1 && !quote.includes('\n');
        // 标的本来就是整块（表格单元格、整条列表项、整个标题…）
        const whole = single && quote.trim() === (blockText ?? '').trim();

        try {
            if (annotation.anchorState !== 'orphaned') {
                const snapshot = captureSnapshot(this._refineNowRanges(annotation, whole), this._muya);
                if (snapshot)
                    return { id, match: 'located', snapshot };
            }

            const block = findReplacementBlock(annotation, this._muya);
            if (block) {
                // 整块标注：对应到的块就是它现在的样子，按命中处理并整块画区间；
                // 只标了块里一部分的，先试着用原引文的前后文把「现在的那一段」夹出来，
                // 夹不出来才是「原句已改写、这是原段落」。
                const bridged = single && !whole ? bridgeRange(block.text, prefix, suffix) : null;
                const range = bridged ?? { start: 0, end: block.text.length };
                const snapshot = captureSnapshot(
                    [{ blockPath: [...block.path], blockName: block.blockName, ...range }],
                    this._muya,
                    { mark: whole || !!bridged },
                );
                if (snapshot) {
                    if (whole || bridged)
                        return { id, match: 'located', snapshot };
                    // 段落还在、但这一句被删掉了：判删除，同时带上所在段落给面板做语境。
                    return { id, match: isQuoteRemoved(annotation, block.text) ? 'missing' : 'block', snapshot };
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
        if (!this._enabled)
            return NO_HIGHLIGHTS;

        // 块（或其祖先）正在销毁时 `parent` 链会在**中途**断开：`path` getter 抛
        // `Cannot destructure property 'path' of 'this.parent'`。`block.parent`
        // 只是第一环——实测崩点更深（内容块还在、它所在的容器已被置空，堆栈是
        // `get path → get path → highlightsFor`，经 `Muya.focus → setCursor →
        // blurHandler → update → patch` 触发）。所以除了快速检查，取值整段兜住。
        if (!block.parent)
            return NO_HIGHLIGHTS;

        // 卡片打开期间即使一条标注都没有（新建第一张卡片），pending 选区也要画。
        if (!this._annotations.length && !this._pendingRanges.length)
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

            for (const entry of cache.values())
                entry.highlights.sort((a, b) => a.start - b.start || a.end - b.end);
        }

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
