import type Content from '../block/base/content';
import type { TBlockPath } from '../block/types';
import type { IHighlight } from '../inlineRenderer/types';
import type { Muya } from '../muya';
import type { Nullable } from '../types';
import type {
    IAnnotation,
    IAnnotationExportItem,
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
    setQuickPhrases(list: string[]) {
        this._quickPhrases = Array.isArray(list) ? [...list] : [];
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
        const annotation: IAnnotation = {
            id: getLongUniqueId(),
            anchor,
            note: text,
            copied: false,
            archived: false,
            anchorState: 'anchored',
            currentText: anchor.quote,
            createdAt: now,
            updatedAt: now,
        };

        this._mutate('add', annotation.id, () => {
            this._annotations.push(annotation);
        });

        return annotation;
    }

    /** 编辑备注；trim 后为空或内容未变时不动。 */
    updateNote(id: string, note: string) {
        const annotation = this._find(id);
        const text = (note ?? '').trim();
        if (!annotation || !text || annotation.note === text)
            return;

        this._mutate('update', id, () => {
            annotation.note = text;
            annotation.updatedAt = Date.now();
        });
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
     * 行内渲染器取的标注高亮（`InlineRenderer.patch` 的唯一入口）。
     * 偏好关闭、条目已归档 / 已失效时不返回任何高亮。
     */
    highlightsFor(block: Content): IHighlight[] {
        if (!this._enabled || !this._annotations.length)
            return NO_HIGHLIGHTS;

        // 块正在销毁 / 重建时（`parent` 被置空），其 `path` getter 会抛
        // `Cannot destructure property 'path' of 'this.parent'`（标题块 blur
        // 重渲染路径实测崩溃）——此时该块不需要高亮，直接返回空。
        if (!block.parent)
            return NO_HIGHLIGHTS;

        return this._highlightMap().get(pathKey(block.path))?.highlights ?? NO_HIGHLIGHTS;
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

        if (this._enabled && this._annotations.length) {
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
        return block ? pathKey(block.path) : null;
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
