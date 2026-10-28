import { describe, expect, it } from 'vitest';
import type { InstallProgress } from '../../ports/update-gateway.port';
import { FakeUpdateGateway } from './fake-update-gateway.adapter';
import { MemoryLogger } from './memory-logger.adapter';

/**
 * Build a fake gateway that never waits.
 *
 * @param enabled - Whether the synthetic update is offered.
 * @returns The gateway and its logger.
 */
function createGateway(enabled: boolean) {
  const logger = new MemoryLogger();
  const gateway = new FakeUpdateGateway({
    enabled: () => enabled,
    currentVersion: '0.1.0',
    logger,
    sleep: () => Promise.resolve(),
  });
  return { gateway, logger };
}

describe('FakeUpdateGateway', () => {
  it('offers nothing while the flag is off', async () => {
    await expect(createGateway(false).gateway.check()).resolves.toBeNull();
  });

  it('offers a newer version with summaries in both languages', async () => {
    const update = await createGateway(true).gateway.check();
    expect(update).toMatchObject({ version: '9.9.9', currentVersion: '0.1.0' });
    expect(Object.keys(JSON.parse(update?.rawNotes ?? '{}') as object)).toEqual(['en', 'fr']);
  });

  it('reports a growing download, then the installation', async () => {
    const steps: InstallProgress[] = [];
    await createGateway(true).gateway.install((progress) => steps.push(progress));
    const downloads = steps.filter((step) => step.phase === 'downloading');
    expect(downloads.length).toBeGreaterThan(1);
    const bytes = downloads.map((step) => step.downloadedBytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
    expect(bytes.at(-1)).toBe(downloads[0]?.totalBytes);
    expect(steps.at(-1)).toEqual({ phase: 'installing' });
  });
});
