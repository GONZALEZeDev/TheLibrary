import { describe, expect, it } from 'vitest';
import { parseReleaseNotes, selectNotesMarkdown } from './release-notes';

describe('selectNotesMarkdown', () => {
  const both = JSON.stringify({ en: '### Added\n\n- Updates', fr: '### Ajouts\n\n- Mises à jour' });

  it('picks the summary of the language of the app', () => {
    expect(selectNotesMarkdown(both, 'fr')).toBe('### Ajouts\n\n- Mises à jour');
    expect(selectNotesMarkdown(both, 'en')).toBe('### Added\n\n- Updates');
  });

  it('falls back to English when the French summary is missing', () => {
    expect(selectNotesMarkdown(JSON.stringify({ en: '- Updates' }), 'fr')).toBe('- Updates');
  });

  it('shows a text that is not the JSON of the workflow as it is', () => {
    expect(selectNotesMarkdown('Bug fixes.', 'fr')).toBe('Bug fixes.');
    expect(selectNotesMarkdown('{"en":1}', 'en')).toBe('{"en":1}');
    expect(selectNotesMarkdown('["a"]', 'en')).toBe('["a"]');
  });

  it('shows nothing for missing or empty notes', () => {
    expect(selectNotesMarkdown(null, 'en')).toBeNull();
    expect(selectNotesMarkdown('  \n', 'en')).toBeNull();
    expect(selectNotesMarkdown(JSON.stringify({ en: '', fr: ' ' }), 'fr')).toBeNull();
  });
});

describe('parseReleaseNotes', () => {
  it('reads paragraphs, headings and items', () => {
    const notes = parseReleaseNotes(
      'First public beta.\n\n### Added\n\n- Updates inside the app.\n- **Steam** sign-in.\n\n### Fixed\n\n* A crash.\n',
    );
    expect(notes).toEqual({
      paragraphs: ['First public beta.'],
      sections: [
        { heading: 'Added', items: ['Updates inside the app.', 'Steam sign-in.'] },
        { heading: 'Fixed', items: ['A crash.'] },
      ],
    });
  });

  it('keeps the text of links and drops their address', () => {
    expect(parseReleaseNotes('- See [the guide](https://example.test) and `code`.')).toEqual({
      paragraphs: [],
      sections: [{ heading: '', items: ['See the guide and code.'] }],
    });
  });

  it('survives odd input without empty headings or items', () => {
    expect(parseReleaseNotes('###\n-\n- \n### Empty\n\n---\n<b>raw</b>\r\n')).toEqual({
      paragraphs: ['<b>raw</b>'],
      sections: [],
    });
  });
});
