/** Minimal CodeMirror surface `scrollSourceEditorToLine` needs. */
interface ISourceEditor {
  setCursor: (
    pos: { line: number; ch: number },
    ch?: number | null,
    options?: { scroll?: boolean }
  ) => void
  heightAtLine: (line: number, mode: 'local' | 'page' | 'div') => number
}

/**
 * Scroll the Source Code editor so `line` sits at the TOP of the viewport,
 * animated.
 *
 * The editor runs CodeMirror with `viewportMargin: Infinity`, so CodeMirror
 * renders the whole document at full height and its own `.CodeMirror-scroll`
 * never scrolls — the OUTER `.source-code` container (`scrollContainer`) is the
 * scrollable element. So neither `cm.scrollTo` nor `cm.scrollIntoView` moves
 * anything; we scroll the container directly to the line's local Y, which puts
 * the line at the top (CodeMirror's `scrollIntoView` only scrolled minimally,
 * leaving the heading at the bottom edge with no animation). `setCursor` gets
 * `scroll: false` so its native caret-into-view scroll doesn't fight the
 * animation.
 */
export function scrollSourceEditorToLine(
  editor: ISourceEditor,
  line: number,
  scrollContainer: HTMLElement | null | undefined
): void {
  editor.setCursor({ line, ch: 0 }, null, { scroll: false })

  if (!scrollContainer) return
  const top = editor.heightAtLine(line, 'local')
  scrollContainer.scrollTo({ top, behavior: 'smooth' })
}

/**
 * Find the 0-based line number of the `headingIndex`-th markdown heading
 * (ATX `# foo` or setext `foo\n===`) in document order, skipping fenced code
 * blocks. Returns -1 when not found.
 *
 * Used by Source Code mode to resolve a TOC entry (whose order matches the
 * document heading order muya builds the TOC from) to a CodeMirror line.
 */
export function findMarkdownHeadingLine(markdown: string, headingIndex: number): number {
  if (headingIndex < 0) return -1

  const lines = markdown.split('\n')
  let fence: string | null = null
  let count = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Toggle fenced-code-block state on ``` / ~~~ markers.
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence === null) fence = marker
      else if (marker === fence) fence = null
      continue
    }
    if (fence !== null) continue

    // ATX heading.
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) {
      if (count === headingIndex) return i
      count++
      continue
    }

    // Setext heading: a non-blank line immediately followed by an `===`/`---`
    // underline.
    const next = lines[i + 1]
    if (line.trim() !== '' && next !== undefined && /^ {0,3}(?:=+|-+)\s*$/.test(next)) {
      if (count === headingIndex) return i
      count++
      i++ // consume the underline line
    }
  }

  return -1
}

export interface IMarkdownHeading {
  /** 0-based line of the heading text (for setext, the text line, not the underline). */
  line: number
  level: number
  text: string
}

const stripInlineMarks = (text: string): string =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .trim()

/**
 * Every markdown heading with its line, level and plain text, using the same
 * rules as `findMarkdownHeadingLine` (fenced code skipped, ATX + setext) so the
 * N-th entry here is the N-th heading `findMarkdownHeadingLine` resolves.
 * A leading front-matter block is skipped as well — its closing `---` would
 * otherwise read as a setext underline. Source Code mode feeds the heading rail
 * from this, since the engine TOC is not refreshed while CodeMirror is editing.
 */
export function listMarkdownHeadings(markdown: string): IMarkdownHeading[] {
  const lines = markdown.split('\n')
  const out: IMarkdownHeading[] = []
  let fence: string | null = null
  let start = 0

  if (/^(---|\+\+\+)\s*$/.test(lines[0] ?? '')) {
    const marker = lines[0]!.trim()
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === marker || (marker === '---' && lines[i]!.trim() === '...')) {
        start = i + 1
        break
      }
    }
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!

    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!
      if (fence === null) fence = marker
      else if (marker === fence) fence = null
      continue
    }
    if (fence !== null) continue

    const atx = line.match(/^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/)
    if (atx) {
      const text = (atx[2] ?? '').replace(/\s+#+\s*$/, '').replace(/^#+$/, '')
      out.push({ line: i, level: atx[1]!.length, text: stripInlineMarks(text) })
      continue
    }

    const next = lines[i + 1]
    if (line.trim() !== '' && next !== undefined && /^ {0,3}(?:=+|-+)\s*$/.test(next)) {
      out.push({ line: i, level: next.trim()[0] === '=' ? 1 : 2, text: stripInlineMarks(line) })
      i++
    }
  }
  return out
}
