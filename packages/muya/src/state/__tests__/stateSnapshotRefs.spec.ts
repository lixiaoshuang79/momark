// @vitest-environment happy-dom

import type { JSONOpList } from 'ot-json1';
import type { Muya } from '../../muya';
import type { TState } from '../types';
import * as json1 from 'ot-json1';
import { describe, expect, it } from 'vitest';
import JSONState, { asDoc } from '../index';

// P2「加载/渲染 O(N²)」clone elimination, part 2 (`src/state/index.ts`).
//
// `dispatch()` and every frame's `_flushOperationCache()` used to hand out TWO
// full-document `structuredClone`s each (`prevDoc` and `doc`) — the clone cost
// scaled with the document, not with the edit, on every keystroke and every
// queued batch. They now hand out the live arrays, which is only safe because
// `json1.type.apply` never writes through its input: it shallow-copies the
// containers along the edited path and leaves everything else shared and
// untouched, so an earlier array stays a correct snapshot of the document.
//
// These specs pin that invariant from three sides: the library promise (frozen
// documents survive an edit), the payload contract (`prevDoc` is the array the
// previous payload described, and later edits do not rewrite it) and the one
// in-repo consumer of `prevDoc` (History's `invertWithDoc`).

interface IJsonChange {
    op: JSONOpList;
    source: string;
    prevDoc: TState[];
    doc: TState[];
}

function makeState(blocks: TState[]) {
    const events: IJsonChange[] = [];
    const muya = {
        options: {
            footnote: false,
            isGitlabCompatibilityEnabled: false,
            trimUnnecessaryCodeBlockEmptyLines: false,
            frontMatter: false,
            math: false,
            listIndentation: 1,
        },
        eventCenter: {
            emit: (name: string, payload: IJsonChange) => {
                if (name === 'json-change')
                    events.push(payload);
            },
        },
    } as unknown as Muya;

    return { state: new JSONState(muya, blocks), events };
}

// Recursively freeze, so any write through the structure throws (ES modules are
// strict mode) instead of passing silently.
function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value))
            deepFreeze((value as Record<string, unknown>)[key]);
        Object.freeze(value);
    }

    return value;
}

// A clone that shares nothing with the original, for "was the snapshot rewritten
// afterwards?" comparisons.
function pristine<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

describe('json state hands out live snapshot references (P2 clone elimination)', () => {
    it('applies to a deep-frozen document without writing through it', () => {
        const { state } = makeState([{ name: 'paragraph', text: 'A' }]);
        const frozen = deepFreeze(state.getStateRef());

        // Top-level insert (clones the array), nested text edit (clones the
        // block) and remove (splices a clone) — the three write shapes apply()
        // performs.
        state.insertOperation([1], { name: 'paragraph', text: 'B' });
        state.flush();
        state.editOperation([0, 'text'], [1, 'X']);
        state.flush();
        state.removeOperation([1]);
        state.flush();

        expect(state.getState().map(b => (b as { text: string }).text)).toEqual(['AX']);

        // The frozen array and its frozen block object are still the original
        // document — nothing was written through them.
        expect(frozen).toEqual([{ name: 'paragraph', text: 'A' }]);
    });

    it('prevDoc of one payload IS the doc of the previous payload, and stays intact', () => {
        const { state, events } = makeState([{ name: 'paragraph', text: 'A' }]);

        state.insertOperation([1], { name: 'paragraph', text: 'B' });
        state.flush();
        expect(events).toHaveLength(1);

        const first = events[0];
        const firstDocSnapshot = pristine(first.doc);

        state.insertOperation([2], { name: 'paragraph', text: 'C' });
        state.flush();
        expect(events).toHaveLength(2);

        const second = events[1];
        // Raw reference, not a clone: the array handed out a moment ago is the
        // one the next payload describes as "before".
        expect(second.prevDoc).toBe(first.doc);
        // …and it still describes the document as it was, not as it is now.
        expect(first.doc).toEqual(firstDocSnapshot);
        expect(first.doc).toHaveLength(2);
        expect(second.doc).toHaveLength(3);
        expect(second.doc).not.toBe(first.doc);
    });

    it('the identity op does not raise the revision and leaves the document reference alone', () => {
        const { state, events } = makeState([{ name: 'paragraph', text: 'A' }]);
        const before = state.revision;
        const ref = state.getStateRef();

        state.dispatch(null, 'user');

        expect(state.revision).toBe(before);
        expect(state.getStateRef()).toBe(ref);
        expect(events[0].prevDoc).toBe(events[0].doc);
    });

    it('revision advances on a real edit and not on a read', () => {
        const { state } = makeState([{ name: 'paragraph', text: 'A' }]);
        const start = state.revision;

        state.getState();
        state.getStateRef();
        expect(state.revision).toBe(start);

        state.insertOperation([1], { name: 'paragraph', text: 'B' });
        state.flush();
        expect(state.revision).toBeGreaterThan(start);

        const bumped = state.revision;
        state.flush(); // nothing queued — no new version
        expect(state.revision).toBe(bumped);
    });

    it('getState() still returns a private copy', () => {
        const { state } = makeState([{ name: 'paragraph', text: 'A' }]);
        const copy = state.getState();

        copy.push({ name: 'paragraph', text: 'SHOULD NOT LAND' });
        (copy[0] as { text: string }).text = 'clobbered';

        expect(state.getStateRef()).toHaveLength(1);
        expect((state.getStateRef()[0] as { text: string }).text).toBe('A');
        expect(state.getMarkdown()).toBe('A\n');
    });

    it('inverting the payload restores the previous document (History’s contract)', () => {
        const { state, events } = makeState([{ name: 'paragraph', text: 'A' }]);

        state.insertOperation([1], { name: 'paragraph', text: 'B' });
        state.flush();
        state.editOperation([1, 'text'], [1, 'X']);
        state.flush();

        const { op, prevDoc, doc } = events[1];
        const inverse = json1.type.invertWithDoc(op, asDoc(prevDoc))!;

        expect(json1.type.apply(asDoc(doc), inverse)).toEqual(prevDoc);
    });
});
