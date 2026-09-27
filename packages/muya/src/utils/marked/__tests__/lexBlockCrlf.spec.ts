import type { TLexedToken } from '../types';
import { describe, expect, it } from 'vitest';
import { lexBlock } from '../lexBlock';

// C-11: `lexBlock` calls `Lexer.blockTokens` directly, and — unlike
// `marked.lex()` — that does not normalize line endings first. A CRLF document
// therefore kept a `\r` glued to the end of every line, which defeats the
// `^`-anchored block starts: headings, fences, list markers and front matter all
// misparse. The fix normalizes at the single entry of `lexBlock`.
//
// Tokens are projected to the fields under test instead of being narrowed out
// of the TLexedToken union.

interface IProjected { type: string; text?: string; lang?: string; depth?: number }

function simplify(tokens: TLexedToken[]): IProjected[] {
    return tokens
        .filter(token => token.type !== 'space')
        .map((token) => {
            const { type, text, lang, depth } = token as {
                type: string;
                text?: string;
                lang?: string;
                depth?: number;
            };

            return {
                type,
                ...(typeof text === 'string' ? { text } : {}),
                ...(typeof lang === 'string' ? { lang } : {}),
                ...(typeof depth === 'number' ? { depth } : {}),
            };
        });
}

describe('lexBlock — CRLF / CR input is normalized before tokenizing (C-11)', () => {
    it('produces the very same tokens for a CRLF source and its LF twin', () => {
        const source = '# Title\n\n- a\n- b\n\n```js\nlet a = 1\n```\n\nbody\n';

        expect(lexBlock(source.replace(/\n/g, '\r\n'))).toEqual(lexBlock(source));
    });

    it('lexes an ATX heading written with CRLF', () => {
        expect(simplify(lexBlock('# Title\r\n\r\nbody\r\n'))).toEqual([
            { type: 'heading', text: 'Title', depth: 1 },
            { type: 'paragraph', text: 'body' },
        ]);
    });

    it('lexes a fenced code block with CRLF (no `\\r` in the info string or the fence)', () => {
        expect(simplify(lexBlock('```js\r\nlet a = 1\r\n```\r\n'))).toEqual([
            { type: 'code', text: 'let a = 1', lang: 'js' },
        ]);
    });

    it('lexes front matter with CRLF', () => {
        // The front-matter regex itself is LF-only (`---\n`), so this case only
        // works because normalization happens before `fm(src)` runs.
        expect(simplify(lexBlock('---\r\ntitle: x\r\n---\r\n\r\n# H\r\n'))).toEqual([
            // The front-matter body keeps its trailing newline (regex group).
            { type: 'frontmatter', text: 'title: x\n', lang: 'yaml' },
            { type: 'heading', text: 'H', depth: 1 },
        ]);
    });

    it('normalizes a lone CR too', () => {
        expect(lexBlock('# Title\r\rbody\r')).toEqual(lexBlock('# Title\n\nbody\n'));
    });
});
