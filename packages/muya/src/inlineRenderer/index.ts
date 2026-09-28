import type Format from '../block/base/format';
import type ParagraphContent from '../block/content/paragraphContent';
import type { Muya } from '../muya';
import type { IRenderCursor } from '../selection/types';
import type { IParagraphState, TContainerState, TState } from '../state/types';
import type { IHighlight, Labels } from './types';
import logger from '../utils/logger';
import { tokenizer } from './lexer';
import Renderer from './renderer';
import { beginRules } from './rules';

const debug = logger('inlineRenderer:');

class InlineRenderer {
    public labels: Labels = new Map();
    public renderer: Renderer;

    // `jsonState.revision` the current `labels` was built from. `-1` can never
    // be a real revision, so the first `patch()` always collects.
    private _labelsRevision = -1;

    constructor(public muya: Muya) {
        this.renderer = new Renderer(muya, this);
    }

    private _tokenizer(block: Format, highlights: IHighlight[]) {
        const { options } = this.muya;
        const { text } = block;
        const { labels } = this;

        // TODO: different content block should have different rules.
        // eg: atxheading.content has no soft|hard line break
        // setextheading.content has no heading rules.
        const hasBeginRules
            = /thematicbreak\.content|paragraph\.content|atxheading\.content/.test(
                block.blockName,
            );

        return tokenizer(text, { hasBeginRules, labels, options, highlights });
    }

    /**
     * Flush every cached image and force inline images to reload.
     *
     * The renderer memoises loaded images in `loadImageMap` (keyed by src,
     * skipped on the next render once `isSuccess` is true) and resolved URLs
     * in `urlMap`. When an image file changes on disk the cached entry would
     * otherwise keep the stale bitmap, so clearing both maps and re-rendering
     * every content block re-runs `loadImageAsync`, which loads the source
     * afresh.
     */
    invalidateImageCache() {
        this.renderer.loadImageMap.clear();
        this.renderer.urlMap.clear();

        const { scrollPage } = this.muya.editor;
        if (!scrollPage)
            return;

        scrollPage.breadthFirstTraverse((node) => {
            if (node.isContent())
                node.update();
        });
    }

    patch(block: Format, cursor?: IRenderCursor, highlights: IHighlight[] = []) {
        this._syncReferenceDefinitions();
        const { domNode } = block;
        if (block.isParent())
            debug.error('Patch can only handle content block');

        // 标注高亮在合并进本次 patch：`patch` 是所有行内渲染（段落 / 标题 / 引用 /
        // 表格单元格）的唯一入口，每次重渲染都会带上标注高亮，不需要另开重放通道，
        // 打字后也不会被冲掉。搜索高亮仍按调用方传入的顺序排在前，重叠区由
        // `union()` 按 `annotation-active > annotation > search` 决定归属。
        const annotations = this.muya.annotation.highlightsFor(block);
        const merged = annotations.length ? highlights.concat(annotations) : highlights;
        const tokens = this._tokenizer(block, merged);
        const html = this.renderer.output(
            tokens,
            block,
            cursor && cursor.block === block ? cursor : {},
        );
        domNode!.innerHTML = html;
    }

    /**
     * Rebuild `labels` only when the document actually changed since the last
     * rebuild.
     *
     * `patch()` runs once per inline-rendered block — once per block while a
     * document is being opened, once per keystroke afterwards — and every call
     * used to redo this collection. `getState()` alone deep-cloned the ENTIRE
     * document (`structuredClone`) per call, so opening an N-block document paid
     * N full-document clones plus N whole-tree walks (the "load/render O(N²)"
     * hotspot); typing in any paragraph paid the same clone per keystroke.
     *
     * Reading the live array removes the clone outright. Keying the rebuild on
     * the state's `revision` removes the repetition: within one document version
     * the label map is a pure function of the state, so re-deriving it per block
     * cannot change the result. Freshness is unchanged — every `patch()` still
     * sees the labels of the current document, because any state change bumps
     * the revision and the next `patch()` rebuilds.
     */
    private _syncReferenceDefinitions() {
        const jsonState = this.muya.editor.jsonState;
        const { revision } = jsonState;
        if (revision === this._labelsRevision)
            return;

        this.labels = this._collectReferenceDefinitions(jsonState.getStateRef());
        this._labelsRevision = revision;
    }

    private _collectReferenceDefinitions(state: TState[]) {
        const labels = new Map();

        const travel = (sts: TState[]) => {
            if (Array.isArray(sts) && sts.length) {
                for (const st of sts) {
                    if (st.name === 'paragraph') {
                        const { label, info } = this.getLabelInfo(st);
                        if (label && info)
                            labels.set(label, info);
                    }
                    else if ((st as TContainerState).children) {
                        travel((st as TContainerState).children);
                    }
                }
            }
        };

        travel(state);

        return labels;
    }

    getLabelInfo(blockOrState: ParagraphContent | IParagraphState) {
        const { text } = blockOrState;
        const tokens = beginRules.reference_definition.exec(text);
        let label = null;
        let info = null;
        if (tokens) {
            label = (tokens[2] + tokens[3]).toLowerCase();
            info = {
                href: tokens[6],
                title: tokens[10] || '',
            };
        }

        return { label, info };
    }
}

export default InlineRenderer;
