/**
 * Tests of the Tauri settings adapter against a fake `@tauri-apps/plugin-store`: no IPC call is
 * made, the plugin is replaced by an in-memory stand-in for the store the Rust shell opens.
 *
 * @packageDocumentation
 */
import { getStore, type Store } from '@tauri-apps/plugin-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriSettingsStore } from './tauri-settings-store.adapter';

vi.mock('@tauri-apps/plugin-store', () => ({ getStore: vi.fn() }));

/** The methods of the plugin `Store` the adapter relies on, as spies. */
interface FakeStore {
  get: ReturnType<typeof vi.fn<(key: string) => Promise<unknown>>>;
  set: ReturnType<typeof vi.fn<(key: string, value: unknown) => Promise<void>>>;
  save: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

/**
 * Create a fake store and make the mocked `getStore` resolve to it.
 *
 * @returns The fake store, to program and inspect its calls.
 */
function openFakeStore(): FakeStore {
  const store: FakeStore = {
    get: vi.fn<(key: string) => Promise<unknown>>().mockResolvedValue(undefined),
    set: vi.fn<(key: string, value: unknown) => Promise<void>>().mockResolvedValue(undefined),
    save: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  // The adapter only calls `get`, `set` and `save`: the rest of the plugin `Store` is not faked.
  vi.mocked(getStore).mockResolvedValue(store as unknown as Store);
  return store;
}

describe('TauriSettingsStore', () => {
  beforeEach(() => {
    vi.mocked(getStore).mockReset();
  });

  it('reads undefined on first launch, when the store holds no document yet', async () => {
    openFakeStore();

    await expect(new TauriSettingsStore().read()).resolves.toBeUndefined();
  });

  it('reads the document saved under the "settings" key of settings.json', async () => {
    const store = openFakeStore();
    store.get.mockResolvedValue({ schemaVersion: 1, language: 'fr' });

    await expect(new TauriSettingsStore().read()).resolves.toEqual({
      schemaVersion: 1,
      language: 'fr',
    });
    expect(getStore).toHaveBeenCalledWith('settings.json');
    expect(store.get).toHaveBeenCalledWith('settings');
  });

  it('writes the document under the "settings" key, then flushes it to disk', async () => {
    const store = openFakeStore();

    await new TauriSettingsStore().write({ schemaVersion: 1, language: 'en' });

    expect(store.set).toHaveBeenCalledWith('settings', { schemaVersion: 1, language: 'en' });
    expect(store.save).toHaveBeenCalledTimes(1);
    // Saving before setting would flush the previous document.
    expect(store.set).toHaveBeenCalledBefore(store.save);
  });

  it('opens the store once, however many calls and concurrent callers use it', async () => {
    openFakeStore();
    const settingsStore = new TauriSettingsStore();

    await Promise.all([settingsStore.read(), settingsStore.read()]);
    await settingsStore.write({ language: 'en' });
    await settingsStore.read();

    expect(getStore).toHaveBeenCalledTimes(1);
  });

  it('rejects when the shell did not open the settings store', async () => {
    vi.mocked(getStore).mockResolvedValue(null);

    await expect(new TauriSettingsStore().read()).rejects.toThrow(
      'did not open the settings store',
    );
  });

  it('retries opening the store after a failed attempt', async () => {
    vi.mocked(getStore).mockResolvedValueOnce(null);
    const settingsStore = new TauriSettingsStore();
    await expect(settingsStore.read()).rejects.toThrow('did not open the settings store');

    // The shell opened the store in the meantime: the rejected promise must not be reused.
    const store = openFakeStore();
    store.get.mockResolvedValue({ language: 'fr' });

    await expect(settingsStore.read()).resolves.toEqual({ language: 'fr' });
    expect(getStore).toHaveBeenCalledTimes(2);
  });
});
