/**
 * The descriptions of the abilities, read into safe nodes.
 *
 * deadlock-api writes the descriptions and the texts of the upgrade tiers as HTML: highlighted
 * numbers (`<span class="highlight">`), keywords the game colours and illustrates
 * (`<span class="inline-attribute-label SpiritDamage">`), line breaks, inline SVG icons and images.
 * That markup comes from a third party, so it is never handed to the page as HTML: this module
 * reads it into a few kinds of nodes the page renders itself, and drops everything else. A script,
 * a style, an inline icon or an image is dropped with its content; any other tag is dropped and its
 * text kept.
 *
 * The reading is a small tokenizer rather than a DOM parser, so that it runs the same in the app and
 * in the tests, with nothing of the markup ever reaching a live document.
 *
 * @packageDocumentation
 */

/** A node of a description. */
export type DescriptionNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'break' }
  | { readonly kind: 'highlight'; readonly text: string }
  | { readonly kind: 'keyword'; readonly keyword: string; readonly text: string };

/** Elements dropped with everything they hold: inline icons, scripts and styles. */
const DROPPED_ELEMENTS = /<(svg|script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

/** A tag (opening, closing or self-closing), a run of text, or a lone `<`. */
const TOKEN = /<(\/?)([a-z][\w-]*)([^>]*)>|([^<]+)|(<)/gi;

/** The classes of a tag's attributes, from `class="…"` or `class='…'`. */
const CLASS_ATTRIBUTE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** The named entities the game's texts use. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** What an open `<span>` makes of the text it holds. */
type SpanKind =
  | { readonly kind: 'highlight' }
  | { readonly kind: 'keyword'; readonly keyword: string }
  | { readonly kind: 'plain' };

/**
 * Decode the character references of a text.
 *
 * @param text - A run of text of the markup.
 * @returns The text, with `&amp;`, `&#39;`, `&#x27;`… decoded. An unknown reference is kept as is.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (reference: string, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : reference;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? reference;
  });
}

/**
 * Tell what a `<span>` makes of its text, from its classes.
 *
 * @param attributes - The attributes of the tag, as written.
 * @returns A highlight, a keyword (the class after `inline-attribute-label`), or plain text.
 */
function spanKindOf(attributes: string): SpanKind {
  const match = CLASS_ATTRIBUTE.exec(attributes);
  const classes = (match?.[1] ?? match?.[2] ?? '').split(/\s+/).filter((name) => name !== '');
  if (classes.includes('highlight')) {
    return { kind: 'highlight' };
  }
  const labelIndex = classes.indexOf('inline-attribute-label');
  const keyword = labelIndex === -1 ? undefined : classes[labelIndex + 1];
  return keyword === undefined ? { kind: 'plain' } : { kind: 'keyword', keyword };
}

/**
 * Append a run of text to the nodes, merged with the last node when it is of the same kind.
 *
 * @param nodes - The nodes read so far.
 * @param text - The run of text, white space collapsed.
 * @param span - The innermost `<span>` that is not plain, or `null`.
 */
function appendText(nodes: DescriptionNode[], text: string, span: SpanKind | null): void {
  const last = nodes.at(-1);
  if (span === null || span.kind === 'plain') {
    if (last?.kind === 'text') {
      nodes[nodes.length - 1] = { kind: 'text', text: last.text + text };
    } else {
      nodes.push({ kind: 'text', text });
    }
  } else if (span.kind === 'highlight') {
    if (last?.kind === 'highlight') {
      nodes[nodes.length - 1] = { kind: 'highlight', text: last.text + text };
    } else {
      nodes.push({ kind: 'highlight', text });
    }
  } else if (last?.kind === 'keyword' && last.keyword === span.keyword) {
    nodes[nodes.length - 1] = { ...last, text: last.text + text };
  } else {
    nodes.push({ kind: 'keyword', keyword: span.keyword, text });
  }
}

/**
 * Remove what would only show as blank space at the edges: line breaks, and the white space at the
 * start of the first text and at the end of the last one.
 *
 * @param nodes - The nodes read.
 * @returns The nodes without blank edges, and without empty texts.
 */
function trimEdges(nodes: DescriptionNode[]): DescriptionNode[] {
  const trimmed = [...nodes];
  while (trimmed[0]?.kind === 'break') {
    trimmed.shift();
  }
  while (trimmed.at(-1)?.kind === 'break') {
    trimmed.pop();
  }
  const first = trimmed[0];
  if (first?.kind === 'text') {
    trimmed[0] = { kind: 'text', text: first.text.trimStart() };
  }
  const last = trimmed.at(-1);
  if (last?.kind === 'text') {
    trimmed[trimmed.length - 1] = { kind: 'text', text: last.text.trimEnd() };
  }
  return trimmed.filter((node) => node.kind === 'break' || node.text !== '');
}

/**
 * Read the markup of a description or of a tier text into safe nodes.
 *
 * @param markup - The markup, as deadlock-api gives it.
 * @returns The nodes in order: texts, line breaks, highlights and keywords. Runs of white space
 *   are collapsed to one space, and the blank edges are removed.
 */
export function parseDescription(markup: string): DescriptionNode[] {
  const nodes: DescriptionNode[] = [];
  // The open `<span>` elements, innermost last.
  const spans: SpanKind[] = [];
  const source = markup.replace(DROPPED_ELEMENTS, '');
  for (const match of source.matchAll(TOKEN)) {
    const [, closing, tagName, attributes = '', text, loneBracket] = match;
    if (text !== undefined || loneBracket !== undefined) {
      const run = decodeEntities(text ?? '<').replace(/\s+/g, ' ');
      const span = spans.findLast((candidate) => candidate.kind !== 'plain') ?? null;
      appendText(nodes, run, span);
      continue;
    }
    const name = tagName?.toLowerCase();
    if (name === 'br') {
      nodes.push({ kind: 'break' });
    } else if (name === 'span' && closing === '') {
      spans.push(spanKindOf(attributes));
    } else if (name === 'span') {
      spans.pop();
    }
    // Any other tag is dropped; its text, read as its own tokens, is kept.
  }
  return trimEdges(nodes);
}
