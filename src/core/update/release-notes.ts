/**
 * The summary of a new version, as the update dialog shows it.
 *
 * A release publishes its summary in English and in French (the sections of `CHANGELOG.md` and
 * `CHANGELOG.fr.md`), packed by the release workflow as a JSON object in the `notes` field of the
 * update file: `{"en": "<markdown>", "fr": "<markdown>"}`. This module picks the summary of the
 * app's language and reads the small part of Markdown a changelog section uses: `### Heading`
 * lines and `- item` lines. Anything else is kept as a plain paragraph, so an unexpected summary is
 * still shown as text, never as markup.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { FALLBACK_LANGUAGE, type Language } from '../settings/language';

/** One heading of a summary (`Added`, `Fixed`…) and its items. */
export interface NotesSection {
  /** Text of the heading; empty for the items written before any heading. */
  readonly heading: string;
  readonly items: readonly string[];
}

/** A summary read from its Markdown. */
export interface ReleaseNotes {
  /** Lines that are neither a heading nor an item (e.g. "First public beta."), in order. */
  readonly paragraphs: readonly string[];
  readonly sections: readonly NotesSection[];
}

/** The `notes` written by the release workflow: English always, French when it was written. */
const notesByLanguageSchema = z.object({ en: z.string(), fr: z.string().optional() });

/**
 * Pick the summary to show from the `notes` of an update.
 *
 * - The JSON object of the release workflow: the entry of `language`, else English.
 * - Any other text (a hand-written or older update file): the text itself, taken as English.
 *
 * @param rawNotes - The `notes` field of the update, `null` when it has none.
 * @param language - Language of the app.
 * @returns The Markdown to show, or `null` when there is nothing to show.
 */
export function selectNotesMarkdown(rawNotes: string | null, language: Language): string | null {
  if (rawNotes === null) return null;
  const parsed = notesByLanguageSchema.safeParse(parseJsonOrNull(rawNotes));
  const markdown = parsed.success
    ? language === FALLBACK_LANGUAGE
      ? parsed.data.en
      : (parsed.data[language] ?? parsed.data.en)
    : rawNotes;
  return markdown.trim() === '' ? null : markdown;
}

/**
 * Parse JSON, or give `null` when the text is not JSON.
 *
 * @param text - The text to parse.
 * @returns The parsed value, or `null`.
 */
function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read the Markdown of a summary into paragraphs and sections.
 *
 * @param markdown - The summary.
 * @returns Its paragraphs and sections, without any Markdown syntax left.
 */
export function parseReleaseNotes(markdown: string): ReleaseNotes {
  const paragraphs: string[] = [];
  const sections: { heading: string; items: string[] }[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (heading !== null) {
      const text = plainText(heading[1] ?? '');
      if (text !== '') sections.push({ heading: text, items: [] });
    } else if (item !== null) {
      const text = plainText(item[1] ?? '');
      if (text === '') continue;
      const current = sections.at(-1);
      if (current === undefined) {
        sections.push({ heading: '', items: [text] });
      } else {
        current.items.push(text);
      }
    } else if (line !== '' && !/^[-*#]+$/.test(line)) {
      paragraphs.push(plainText(line));
    }
  }
  // A heading with no item says nothing on its own.
  return { paragraphs, sections: sections.filter((section) => section.items.length > 0) };
}

/**
 * Remove the inline Markdown of a line: links keep their text, emphasis and code marks go.
 *
 * @param text - One line of Markdown.
 * @returns The plain text.
 */
function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .trim();
}
