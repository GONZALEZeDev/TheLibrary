/**
 * The page the system browser shows once Steam has sent the player back to the app.
 *
 * @packageDocumentation
 */

/**
 * The HTML the loopback listener answers with, in English then in French: the player is told to
 * close the tab and go back to the app, whatever the language of the app.
 *
 * Three facts about the listener (the `tauri-plugin-oauth` plugin) shape this page:
 *
 * - The plugin inserts its own script right after `<head>`. That script reads the full URL of the
 *   page, query included, and hands it to the app, so it runs before the script of the body. The
 *   body's script then replaces the address with `/callback`: the URL carries the nonce and the
 *   player's Steam assertion, and should not stay in the address bar or in the browser history.
 * - The plugin sends no `Content-Type` header, so the browser cannot learn the encoding from the
 *   response. The `<meta charset>` is what makes the French accent display correctly.
 * - The page loads no external resource (no stylesheet, font, image or script file, and no link),
 *   so showing it sends nothing to any server and never waits on the network.
 */
export const CALLBACK_PAGE_HTML = [
  '<!doctype html><html lang="en">',
  '<head><meta charset="utf-8"><title>TheLibrary</title></head>',
  '<body>',
  '<p>You can close this tab and go back to TheLibrary.</p>',
  '<p lang="fr">Tu peux fermer cet onglet et revenir à TheLibrary.</p>',
  "<script>history.replaceState(null, '', '/callback');</script>",
  '</body></html>',
].join('');
