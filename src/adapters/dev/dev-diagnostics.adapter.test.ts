/**
 * Tests of the diagnostics of the browser dev mode, which has no log folder.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import type { Diagnostics } from '../../ports/diagnostics.port';
import { DevDiagnostics } from './dev-diagnostics.adapter';

describe('DevDiagnostics', () => {
  it('has no log folder to open', async () => {
    const diagnostics = new DevDiagnostics();

    expect(diagnostics.canOpenLogFolder).toBe(false);
    const failure: unknown = await diagnostics.openLogFolder().catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ kind: 'storage' });
  });

  it('accepts the detailed log switch, its logger keeping every line anyway', () => {
    // Called through the port, as the settings page does.
    const diagnostics: Diagnostics = new DevDiagnostics();

    expect(() => {
      diagnostics.setDebugLogging(true);
    }).not.toThrow();
  });
});
