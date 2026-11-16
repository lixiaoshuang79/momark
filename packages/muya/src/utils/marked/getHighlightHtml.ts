import type { ILexOption } from './types';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import Prism from 'prismjs';
import { canHighlightCode } from '../codeHighlightBudget';
import cjkEmStrongExtension from './extensions/cjkEmStrong';
import emojiExtension from './extensions/emoji';
import footnoteExtension from './extensions/footnote';
import mathExtension from './extensions/math';
import superSubScriptExtension from './extensions/superSubscript';
import fm, { frontMatterRender } from './frontMatter';
import { visitTokens } from './lexBlock';
import { DEFAULT_OPTIONS } from './options';
import walkTokens from './walkTokens';

const DIAGRAM_TYPE = [
    'mermaid',
    'plantuml',
    'vega-lite',
    'flowchart',
    'sequence',
];

function highlight(code: string, lang: string) {
    // Language may be undefined (GH#591)
    if (!lang)
        return code;

    if (DIAGRAM_TYPE.includes(lang))
        return code;

    // 与编辑器内的代码块同一预算：超长 / 含长段编码载荷的代码按纯文本导出。
    if (!canHighlightCode(code))
        return code;

    const grammar = Prism.languages[lang];
    if (!grammar) {
        console.warn(`Unable to find grammar for "${lang}".`);
        return code;
    }
    return Prism.highlight(code, grammar, lang);
}

// The Marked instance `getHighlightHtml` renders with: code highlighting plus
// the muya extensions selected by `options`. Exported for the equivalence spec.
export function createHtmlMarked(options: ILexOption) {
    const { math, isGitlabCompatibilityEnabled, superSubScript, footnote } = options;

    // Build a fresh Marked instance per call. `Marked.use({ walkTokens })`
    // chains rather than replaces, so reusing a module-level singleton would
    // cause walkTokens to fire N times after N invocations and corrupt token
    // state (e.g. wiping `lang` on subsequent runs).
    const marked = new Marked(markedHighlight({ highlight }));

    marked.use({
        walkTokens: walkTokens({ math, isGitlabCompatibilityEnabled }),
    });

    // Treat CJK characters as punctuation for emphasis/strong flanking so
    // `中文**"加粗"**中文` bolds (marktext/marktext#4307). Additive override —
    // never regresses spec-conformant Latin emphasis.
    marked.use(cjkEmStrongExtension());

    marked.use(emojiExtension({ isRenderEmoji: true }));

    if (math) {
        marked.use(
            mathExtension({
                throwOnError: false,
                useKatexRender: true,
            }),
        );
    }

    if (superSubScript)
        marked.use(superSubScriptExtension());

    if (footnote)
        marked.use(footnoteExtension());

    return marked;
}

// Run the instance's (composed) `walkTokens` callback through the in-place
// visitor instead of marked's own walk, which concatenates every callback
// result into one growing array — quadratic in document size (1.4s of a 2.3s
// HTML export of a 2MB document). Same visiting order, same position in the
// pipeline: `processAllTokens` runs right where marked would start its walk.
// The results marked collects only matter for async walkers (none here: code
// highlighting is synchronous).
function useLinearWalkTokens(marked: Marked) {
    const walk = marked.defaults.walkTokens;
    if (!walk)
        return;

    marked.setOptions({ walkTokens: null });
    marked.use({
        hooks: {
            processAllTokens(tokens) {
                visitTokens(tokens, token => walk.call(marked, token), marked.defaults.extensions?.childTokens);

                return tokens;
            },
        },
    });
}

export function getHighlightHtml(src: string, options: ILexOption = {}) {
    options = Object.assign({}, DEFAULT_OPTIONS, options);

    const marked = createHtmlMarked(options);
    useLinearWalkTokens(marked);

    let html = '';

    if (options.frontMatter) {
        const { token, src: newSrc } = fm(src);
        if (token) {
            html = frontMatterRender(token);
            src = newSrc;
        }
    }

    html += marked.parse(src);

    return html;
}
