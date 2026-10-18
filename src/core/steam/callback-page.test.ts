/**
 * Tests of the page the browser shows once Steam has sent the player back to the app.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { CALLBACK_PAGE_HTML } from './callback-page';

describe('CALLBACK_PAGE_HTML', () => {
  it('is a self-contained UTF-8 page that clears the address bar', () => {
    expect(CALLBACK_PAGE_HTML).toContain('<head>');
    expect(CALLBACK_PAGE_HTML).toContain('<meta charset="utf-8">');
    expect(CALLBACK_PAGE_HTML).toContain('history.replaceState');
    // No external resource, link or address: the page only tells the player what to do.
    expect(CALLBACK_PAGE_HTML).not.toContain('src=');
    expect(CALLBACK_PAGE_HTML).not.toContain('href=');
    expect(CALLBACK_PAGE_HTML).not.toContain('http');
  });

  it('is one line of markup, without any whitespace between the tags', () => {
    expect(CALLBACK_PAGE_HTML).toBe(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TheLibrary</title></head><body><p>You can close this tab and go back to TheLibrary.</p><p lang="fr">Tu peux fermer cet onglet et revenir à TheLibrary.</p><script>history.replaceState(null, '', '/callback');</script></body></html>`,
    );
  });

  it('tells the player in English and in French to go back to the app', () => {
    expect(CALLBACK_PAGE_HTML).toContain('You can close this tab and go back to TheLibrary.');
    expect(CALLBACK_PAGE_HTML).toContain('Tu peux fermer cet onglet et revenir à TheLibrary.');
  });
});
