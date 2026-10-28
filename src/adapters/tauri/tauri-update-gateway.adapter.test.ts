import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import type { InstallProgress } from '../../ports/update-gateway.port';
import { TauriUpdateGateway, type UpdaterFunctions } from './tauri-update-gateway.adapter';

/**
 * Build what the plugin returns for an available update.
 *
 * @param fields - Fields to change.
 * @param downloadAndInstall - What installing does.
 * @returns The fake update.
 */
function fakeUpdate(
  fields: { readonly date?: string | undefined; readonly body?: string | undefined } = {},
  downloadAndInstall: (onEvent: (event: DownloadEvent) => void) => Promise<void> = () =>
    Promise.resolve(),
): Update {
  return {
    version: '0.2.0',
    currentVersion: '0.1.0',
    date: '2026-11-02 12:00:00.0 +00:00:00',
    body: '{"en":"x"}',
    ...fields,
    downloadAndInstall: vi.fn(downloadAndInstall),
    close: vi.fn(() => Promise.resolve()),
  } as unknown as Update;
}

/**
 * Build the plugin functions.
 *
 * @param update - What the check returns.
 * @returns The functions, as mocks.
 */
function plugin(update: Update | null | Error) {
  return {
    check: vi.fn<UpdaterFunctions['check']>(() =>
      update instanceof Error ? Promise.reject(update) : Promise.resolve(update),
    ),
    openUrl: vi.fn<UpdaterFunctions['openUrl']>(() => Promise.resolve()),
  };
}

describe('TauriUpdateGateway', () => {
  it('gives null when the installed version is the latest', async () => {
    await expect(new TauriUpdateGateway(plugin(null)).check()).resolves.toBeNull();
  });

  it('maps the update of the plugin', async () => {
    const functions = plugin(fakeUpdate({ date: '2026-11-02T12:00:00Z' }));
    await expect(new TauriUpdateGateway(functions).check()).resolves.toEqual({
      version: '0.2.0',
      currentVersion: '0.1.0',
      date: Date.UTC(2026, 10, 2, 12),
      rawNotes: '{"en":"x"}',
    });
    expect(functions.check).toHaveBeenCalledWith({ timeout: 15_000 });
  });

  it('gives no date and no notes when the update file has none or an unreadable date', async () => {
    const update = await new TauriUpdateGateway(
      plugin(fakeUpdate({ date: 'not a date', body: undefined })),
    ).check();
    expect(update).toMatchObject({ date: null, rawNotes: null });
  });

  it('turns a failed check into a network error', async () => {
    const error = await new TauriUpdateGateway(plugin(new Error('error sending request')))
      .check()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ kind: 'network' });
  });

  it('refuses to install before an update was found', async () => {
    const gateway = new TauriUpdateGateway(plugin(null));
    await gateway.check();
    await expect(gateway.install(() => undefined)).rejects.toMatchObject({ kind: 'unexpected' });
  });

  it('adds up the chunks of the download, then reports the installation', async () => {
    const update = fakeUpdate({}, (onEvent) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 30 } });
      onEvent({ event: 'Progress', data: { chunkLength: 70 } });
      onEvent({ event: 'Finished' });
      return Promise.resolve();
    });
    const gateway = new TauriUpdateGateway(plugin(update));
    await gateway.check();
    const steps: InstallProgress[] = [];
    await gateway.install((progress) => steps.push(progress));
    expect(steps).toEqual([
      { phase: 'downloading', downloadedBytes: 0, totalBytes: 100 },
      { phase: 'downloading', downloadedBytes: 30, totalBytes: 100 },
      { phase: 'downloading', downloadedBytes: 100, totalBytes: 100 },
      { phase: 'installing' },
    ]);
  });

  it('reports an unknown size as null', async () => {
    const update = fakeUpdate({}, (onEvent) => {
      onEvent({ event: 'Started', data: {} });
      return Promise.resolve();
    });
    const gateway = new TauriUpdateGateway(plugin(update));
    await gateway.check();
    const steps: InstallProgress[] = [];
    await gateway.install((progress) => steps.push(progress));
    expect(steps).toEqual([{ phase: 'downloading', downloadedBytes: 0, totalBytes: null }]);
  });

  it('turns a refused signature into an invalid payload', async () => {
    const update = fakeUpdate({}, () => Promise.reject(new Error('signature verification failed')));
    const gateway = new TauriUpdateGateway(plugin(update));
    await gateway.check();
    await expect(gateway.install(() => undefined)).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('releases the update a newer check replaces', async () => {
    const first = fakeUpdate();
    const close = vi.spyOn(first, 'close');
    const functions = plugin(first);
    const gateway = new TauriUpdateGateway(functions);
    await gateway.check();
    functions.check.mockResolvedValue(null);
    await gateway.check();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('opens the GitHub page of the release', async () => {
    const functions = plugin(null);
    await new TauriUpdateGateway(functions).openReleasePage('0.2.0');
    expect(functions.openUrl).toHaveBeenCalledWith(
      'https://github.com/GONZALEZeDev/TheLibrary/releases/tag/v0.2.0',
    );
  });
});
