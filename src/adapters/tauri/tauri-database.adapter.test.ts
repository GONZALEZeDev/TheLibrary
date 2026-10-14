/**
 * Tests of the Tauri database adapter, with a fake of the plugin's database handle.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import { TauriDatabase, type PluginDatabase } from './tauri-database.adapter';

/**
 * Create a fake handle of the plugin.
 *
 * @returns The fake and its two methods.
 */
function createPluginDatabase() {
  const execute = vi.fn<PluginDatabase['execute']>(() =>
    Promise.resolve({ rowsAffected: 3, lastInsertId: 0 }),
  );
  const select = vi.fn(() =>
    Promise.resolve([{ key: 'a' }]),
  ) as unknown as PluginDatabase['select'];
  return { database: { execute, select }, execute, select };
}

describe('TauriDatabase', () => {
  it('runs a statement with its parameters and returns the number of changed rows', async () => {
    const plugin = createPluginDatabase();

    const changed = await new TauriDatabase(plugin.database).execute(
      'DELETE FROM sync_state WHERE key = $1',
      ['a'],
    );

    expect(changed).toBe(3);
    expect(plugin.execute).toHaveBeenCalledWith('DELETE FROM sync_state WHERE key = $1', ['a']);
  });

  it('runs a query and returns its rows', async () => {
    const plugin = createPluginDatabase();

    const rows = await new TauriDatabase(plugin.database).select('SELECT key FROM sync_state');

    expect(rows).toEqual([{ key: 'a' }]);
    expect(plugin.select).toHaveBeenCalledWith('SELECT key FROM sync_state', []);
  });

  it('propagates the failures of the plugin as they are, for the caller to wrap', async () => {
    const plugin = createPluginDatabase();
    plugin.execute.mockRejectedValueOnce(
      'error returned from database: (code: 5) database is locked',
    );

    await expect(new TauriDatabase(plugin.database).execute('DELETE FROM matches')).rejects.toBe(
      'error returned from database: (code: 5) database is locked',
    );
  });
});
