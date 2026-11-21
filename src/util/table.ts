/**
 * Monospace tables for Discord embeds. Kept within ~36 characters per line so they fit a phone
 * screen without wrapping. Plain text only (no box-drawing characters or symbols).
 */

export interface Column {
  header: string;
  align?: 'left' | 'right';
  /** Maximum width; longer cells are shortened with "..". */
  max?: number;
}

/** Characters that would break out of a code block or render oddly. */
function clean(s: string): string {
  return s.replace(/`/g, "'").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ');
}

function fit(s: string, max: number | undefined): string {
  if (!max || s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 2)) + '..';
}

/**
 * Renders rows as an aligned table inside a code block. Rows that would push the result past
 * `maxChars` (Discord fields hold 1024) are left out and summarized below the block, so the
 * code block is never cut in the middle.
 */
export function table(columns: readonly Column[], rows: ReadonlyArray<readonly string[]>, gap = 2, maxChars = 1000): string {
  const cells = rows.map((r) => columns.map((c, i) => fit(clean(r[i] ?? ''), c.max)));
  const render = (n: number): string => {
    const shown = cells.slice(0, n);
    const widths = columns.map((c, i) => Math.max(c.header.length, ...shown.map((r) => r[i]!.length)));
    const pad = (s: string, i: number) => ((columns[i]!.align ?? 'left') === 'right' ? s.padStart(widths[i]!) : s.padEnd(widths[i]!));
    const sep = ' '.repeat(gap);
    const lines = [
      columns
        .map((c, i) => pad(c.header, i))
        .join(sep)
        .trimEnd(),
      ...shown.map((r) => r.map(pad).join(sep).trimEnd()),
    ];
    const hidden = cells.length - n;
    return '```\n' + lines.join('\n') + '\n```' + (hidden > 0 ? `\n...and ${hidden} more` : '');
  };
  let n = cells.length;
  let out = render(n);
  while (out.length > maxChars && n > 0) out = render(--n);
  return out;
}
