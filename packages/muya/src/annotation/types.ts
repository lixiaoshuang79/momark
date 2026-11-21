import type { TBlockPath } from '../block/types';
import type { IAnchorFocusInfo } from '../selection/types';
import type { Nullable } from '../types';

/**
 * 行内高亮类型。`search` 是既有搜索高亮的**缺省值**（`IHighlight` 不写 `type`
 * 时按它处理，旧行为一字不变）；另外两种属于标注：
 * `annotation` = 常规标注，`annotation-active` = 当前激活条（卡片编辑中 / 面板定位）。
 * 重叠时按 `annotation-active > annotation > search` 取高优先级。
 */
export type THighlightType = 'search' | 'annotation' | 'annotation-active' | 'annotation-pending';

/**
 * 标注高亮 span 的 class 名，与 `assets/styles/index.css` 中的规则一一对应。
 *
 * 没有加进 `config/index.ts` 的 `CLASS_NAMES`：那份表是集中生成的，本轮改动的
 * 文件边界不含该文件，把常量就近放在标注模块里可以避免越界修改。
 */
export const ANNOTATION_CLASS_NAMES = {
    MU_ANNOTATION: 'mu-annotation',
    MU_ANNOTATION_ACTIVE: 'mu-annotation-active',
    /** 卡片打开期间「正在标注的选区」：选中态观感（用户拍板）。 */
    MU_ANNOTATION_PENDING: 'mu-annotation-pending',
} as const;

/** 一段（块内）定位；跨块标注有多段，按文档顺序。 */
export interface IAnnotationRange {
    blockPath: TBlockPath;
    blockName: string;
    start: number;
    end: number;
}

/** 多层锚点：quote 为主锚，其余为消歧与兜底。 */
export interface IAnnotationAnchor {
    ranges: IAnnotationRange[];
    quote: string;
    prefix: string;
    suffix: string;
    blockText: string;
    blockTextTail?: string;
    beforeBlockText: string;
    afterBlockText: string;
    blockPath: TBlockPath;
    headingPath: string[];
}

/** 锚点健康度：内部技术维度，只以一行辅助提示露出。 */
export type TAnchorState = 'anchored' | 'relocated' | 'orphaned';

/**
 * 标注处所在块的「样子」归类（历史对比用）。由块的 state 链推出：
 * 最内层叶子 + 最近的列表/表格/引用容器。
 */
export type TSnapshotKind
    = | 'paragraph'
        | 'heading'
        | 'list'
        | 'task'
        | 'table'
        | 'quote'
        | 'code'
        | 'math'
        | 'html'
        | 'diagram'
        | 'frontmatter'
        | 'footnote'
        | 'other';

/**
 * 标注处的样式快照（feat/annotation-history-compare）。
 *
 * 不是像素截图，而是「能重新渲染出同样样子的最小 markdown」：从标注所在的
 * 顶层块 state 出发，只保留通向标注段的那条子树（列表只留命中的那一项、表格
 * 留表头 + 命中行、引用只留命中的子块），序列化成 markdown；`markStart/markEnd`
 * 是标注段在这份 markdown 里的位置（渲染时据此画高亮）。
 *
 * 快照是只读的：`IAnnotation.origin` 在新建时写一次、永不回写；「现在」的快照
 * 每次查看历史时现算（`AnnotationModule.inspect`），不落盘。
 */
export interface IAnnotationSnapshot {
    kind: TSnapshotKind;
    /** 顶层 → 叶子的 state 名链，如 `['block-quote', 'bullet-list', 'list-item', 'paragraph']`。 */
    trail: string[];
    /** 标题级别（kind=heading）。 */
    level?: number;
    /** 代码块语言（kind=code，取 info string 首词）。 */
    lang?: string;
    /** 任务项勾选态（kind=task）。 */
    checked?: boolean;
    /** 表格坐标（kind=table；row=0 为表头）。 */
    cell?: { row: number; col: number };
    /** 可渲染的上下文 markdown（已剪枝）。 */
    markdown: string;
    /** 标注段在 `markdown` 内的区间；-1 = 无法定位（只渲染、不画高亮）。 */
    markStart: number;
    markEnd: number;
    /** 标注段源码（raw markdown，跨块按 `\n` 拼接）。 */
    text: string;
    /** 标注段渲染后的纯文本（去行内标记、去标题井号）——判断「改了字」用。 */
    plain: string;
    capturedAt: number;
    /** 由旧版（v2）锚点字段反推出的近似快照：没有真实块结构，只是尽力还原。 */
    legacy?: boolean;
}

/** `inspect()` 的「现在」：按原锚点命中 / 按原位置对应到段落 / 已删除。 */
export type TInspectMatch = 'located' | 'block' | 'missing';

export interface IAnnotationInspection {
    id: string;
    match: TInspectMatch;
    /** located / block：现在的样子；missing：引文所在段落还在时为该段落（不画区间），否则 null。 */
    snapshot: IAnnotationSnapshot | null;
}

export interface IAnnotation {
    id: string;
    anchor: IAnnotationAnchor;
    note: string;
    /**
     * 全局备注：不锚定正文内容（`anchor.ranges` 为空）、正文不画高亮、
     * 不参与重定位；复制文本里这类条目抬头写「全局备注」。
     */
    global?: boolean;

    // ── 用户可见状态：只有"未复制 / 已复制" ──
    copied: boolean;
    round?: number;
    sentQuote?: string;
    /** 复制那一轮里它在复制文本中的序号（`[n]`），历史里按它排序、与 agent 回复对照。 */
    sentIndex?: number;
    /** 标注时的样式快照（新建时写一次，永不回写；v2 旧数据没有）。 */
    origin?: IAnnotationSnapshot;

    // ── 归档：移出当前列表、进入历史 ──
    archived: boolean;
    archivedAt?: number;

    // ── 内部维度 / 辅助提示 ──
    anchorState: TAnchorState;
    currentText?: string;
    contentChanged?: boolean;

    createdAt: number;
    updatedAt: number;
}

/** 导出给宿主生成复制文本的结构化数据（引擎出数据，桌面出文案）。 */
export interface IAnnotationExportItem {
    /** 条目 id（复制后据此记录 `sentIndex`）。 */
    id: string;
    index: number;
    headingPath: string[];
    lineStart?: number;
    lineEnd?: number;
    quote: string;
    blockText: string;
    note: string;
    orphaned: boolean;
    fragment: boolean;
    /** 全局备注（见 `IAnnotation.global`）：无章节/行号可写。 */
    global?: boolean;
}

/**
 * 工具条交给引擎的选区快照（B 通道发射，引擎与桌面各自订阅）。
 * 结构与 `Selection.getSelection()` 的两个端点一致，可直接由 B 通道组装。
 */
export interface ISelectionEndpoint extends IAnchorFocusInfo {}

export interface ISelectionSnapshotPayload {
    // 端点与块引用按 `Nullable` 收：工具条在「有选区」的分支里发这个事件，但引擎
    // 侧本来就对空值做了兜底（拿不到块就返回 null / 不发高亮），类型上就不强求。
    anchor: Nullable<ISelectionEndpoint>;
    focus: Nullable<ISelectionEndpoint>;
    anchorBlock: Nullable<ISelectionEndpoint['block']>;
    focusBlock: Nullable<ISelectionEndpoint['block']>;
    anchorPath: TBlockPath;
    focusPath: TBlockPath;
}

/** 契约冻结的名字（对外就用这个别名；interface 必须 `I` 开头，见仓库 lint 规则）。 */
export type TSelectionSnapshot = ISelectionSnapshotPayload;

/** `annotation-change` 事件的 payload。 */
export type TAnnotationChangeType = 'add' | 'update' | 'remove' | 'relocate' | 'view';

export interface IAnnotationChangePayload {
    type: TAnnotationChangeType;
    id?: string;
}
