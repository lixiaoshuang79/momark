import type { IMatch, ISearchOption } from '../search/types';

// Shape returned by `matchString` — the (pre-`IMatch`) per-string match record
// the search module maps onto its blocks.
export interface IStrMatch {
    match: string;
    subMatches: string[];
    index: number;
}

// Global-match iteration, owned instead of borrowed from `execall`.
//
// The dependency's loop is `while (match = re.exec(string))` with no
// zero-width guard, so a pattern that can match the empty string (`^`, `$`,
// `\b`, `a*`, a plain empty search…) never advances `lastIndex`: `exec` returns
// the same empty match forever → the renderer spins and OOMs while the user is
// still typing the pattern (P0-8). Two rules keep this loop finite:
//   * a zero-width match is NOT a result (nothing to highlight/replace), so it
//     is dropped, but
//   * it still advances `lastIndex` by one so the scan makes progress.
function execAllMatch(regexp: RegExp, text: string): IStrMatch[] {
    const matches: IStrMatch[] = [];
    // Own instance: `lastIndex` is per-RegExp state and callers may reuse the
    // pattern. `source`/`flags` round-trip (incl. `u`/`i`/`g`).
    const re = new RegExp(regexp.source, regexp.flags);
    let match = re.exec(text);

    while (match !== null) {
        if (match[0].length > 0)
            matches.push({ match: match[0], subMatches: match.slice(1), index: match.index ?? 0 });
        else
            re.lastIndex += 1;

        if (!re.global)
            break;

        match = re.exec(text);
    }

    return matches;
}

export function matchString(text: string, value: string, options: ISearchOption) {
    const { isCaseSensitive, isWholeWord, isRegexp } = options;

    const SPECIAL_CHAR_REG = /[[\]\\^$.|?*+()/]/g;

    let SEARCH_REG = null;
    let regStr = value;
    let flag = 'g';

    if (!isCaseSensitive)
        flag += 'i';

    if (!isRegexp) {
        regStr = value.replace(SPECIAL_CHAR_REG, (p) => {
            return p === '\\' ? '\\\\' : `\\${p}`;
        });
    }

    if (isWholeWord)
        regStr = `\\b${regStr}\\b`;

    try {
    // Add try catch expression because not all string can generate a valid RegExp. for example `\`.
        SEARCH_REG = new RegExp(regStr, flag);

        return execAllMatch(SEARCH_REG, text);
    }
    catch {
        return [];
    }
}

// Expand `$0` (whole match) / `$N` (capture group) in a regex replacement, the
// marktext 4c517b16 contract.
//
// The substitution MUST be a function: with a string replacement the expanded
// text is re-scanned for `$&`/`$$`/`$1` and silently rewritten whenever the
// document itself contains those sequences (searching `\$\w` in a doc holding
// `$&` replaced it with `$0` — the match — instead of the literal `$&`, C-5).
// One `replace` pass over the original `value` also keeps an expansion that
// happens to contain `$N` from being expanded a second time by a later
// iteration of the old per-token loop.
export function buildRegexValue(match: IMatch, value: string) {
    return value.replace(/(?<!\\)\$(\d)/g, (token, digit: string) => {
        const index = Number.parseInt(digit, 10);
        if (index === 0)
            return match.match;

        if (index > 0 && index <= match.subMatches.length)
            return match.subMatches[index - 1];

        // Out of range / escaped: leave the token verbatim.
        return token;
    });
}
