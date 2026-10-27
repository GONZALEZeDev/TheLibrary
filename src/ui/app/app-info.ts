/**
 * What the app knows about itself: its version, for the About section of the settings and for the
 * composition root, which sends it to deadlock-api in the User-Agent.
 *
 * @packageDocumentation
 */

/** Version of the app (package.json), written into the bundle by Vite: see `define` in vite.config.ts. */
declare const __APP_VERSION__: string;

/** Version of the app, such as `0.1.0`. */
export const APP_VERSION: string = __APP_VERSION__;
