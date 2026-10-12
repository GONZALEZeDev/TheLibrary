/**
 * Tests of the log line format written by the Tauri logger. Importing the adapter performs no IPC
 * call, so it is safe under jsdom.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { formatLogLine } from './tauri-logger.adapter';

describe('formatLogLine', () => {
  it('prefixes the message with its scope', () => {
    expect(formatLogLine('app', 'TheLibrary started', {})).toBe('[app] TheLibrary started');
  });

  it('appends the context as JSON so it reaches the log file', () => {
    expect(formatLogLine('sync.history', 'Fetched', { matches: 12, fresh: true })).toBe(
      '[sync.history] Fetched {"matches":12,"fresh":true}',
    );
  });
});
