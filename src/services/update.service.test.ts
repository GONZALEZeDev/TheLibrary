import { describe, expect, it, vi } from 'vitest';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { AppError } from '../core/errors/app-error';
import type { AvailableUpdate, UpdateGateway } from '../ports/update-gateway.port';
import { UpdateService } from './update.service';

const UPDATE: AvailableUpdate = {
  version: '0.2.0',
  currentVersion: '0.1.0',
  date: Date.UTC(2026, 10, 2),
  rawNotes: null,
};

/**
 * Build a gateway whose methods are mocks.
 *
 * @param overrides - Methods to replace.
 * @returns The gateway.
 */
function stubGateway(overrides: Partial<UpdateGateway> = {}) {
  return {
    check: vi.fn<UpdateGateway['check']>(() => Promise.resolve(UPDATE)),
    install: vi.fn<UpdateGateway['install']>(() => Promise.resolve()),
    openReleasePage: vi.fn<UpdateGateway['openReleasePage']>(() => Promise.resolve()),
    ...overrides,
  };
}

/** The log lines above `debug`. */
function visibleLines(logger: MemoryLogger) {
  return logger.entries.filter((entry) => entry.level !== 'debug');
}

describe('UpdateService', () => {
  it('without a gateway, finds no update and logs nothing above debug', async () => {
    const logger = new MemoryLogger();
    const service = new UpdateService(null, logger);
    await expect(service.checkAtStartup()).resolves.toBeNull();
    await expect(service.checkNow()).resolves.toBeNull();
    expect(visibleLines(logger)).toEqual([]);
    await expect(service.install(() => undefined)).rejects.toBeInstanceOf(AppError);
  });

  it('asks the gateway once at startup, however often the result is read', async () => {
    const gateway = stubGateway();
    const service = new UpdateService(gateway, new MemoryLogger());
    await expect(service.checkAtStartup()).resolves.toEqual(UPDATE);
    await expect(service.checkAtStartup()).resolves.toEqual(UPDATE);
    expect(gateway.check).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed startup check silent: no update, one warn line', async () => {
    const logger = new MemoryLogger();
    const gateway = stubGateway({
      check: () => Promise.reject(new AppError('network', 'offline')),
    });
    const service = new UpdateService(gateway, logger);
    await expect(service.checkAtStartup()).resolves.toBeNull();
    const lines = visibleLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      scope: 'update',
      context: { kind: 'network' },
    });
  });

  it('reports a failed manual check with the error of the gateway', async () => {
    const error = new AppError('timeout', 'slow');
    const service = new UpdateService(
      stubGateway({ check: () => Promise.reject(error) }),
      new MemoryLogger(),
    );
    await expect(service.checkNow()).rejects.toBe(error);
  });

  it('asks the gateway again at every manual check', async () => {
    const gateway = stubGateway({ check: vi.fn(() => Promise.resolve(null)) });
    const logger = new MemoryLogger();
    const service = new UpdateService(gateway, logger);
    await service.checkNow();
    await service.checkNow();
    expect(gateway.check).toHaveBeenCalledTimes(2);
    expect(logger.entries.at(-1)).toMatchObject({ level: 'info', message: 'No update available' });
  });

  it('runs one installation at a time', async () => {
    let finish: () => void = () => undefined;
    const gateway = stubGateway({
      install: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const service = new UpdateService(gateway, new MemoryLogger());
    const first = service.install(() => undefined);
    const second = service.install(() => undefined);
    expect(second).toBe(first);
    finish();
    await first;
    expect(gateway.install).toHaveBeenCalledTimes(1);
    // Once done, a new installation can start (e.g. after a failure the player retries).
    void service.install(() => undefined);
    expect(gateway.install).toHaveBeenCalledTimes(2);
  });

  it('logs a failed installation at error and rethrows it', async () => {
    const logger = new MemoryLogger();
    const error = new AppError('invalid_payload', 'bad signature');
    const service = new UpdateService(
      stubGateway({ install: () => Promise.reject(error) }),
      logger,
    );
    await expect(service.install(() => undefined)).rejects.toBe(error);
    expect(logger.entries.at(-1)).toMatchObject({ level: 'error', scope: 'update' });
  });

  it('offers the update a check found, until the player puts it off', async () => {
    const service = new UpdateService(stubGateway(), new MemoryLogger());
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    expect(service.getOffered()).toBeNull();

    await service.checkAtStartup();
    expect(service.getOffered()).toEqual(UPDATE);
    expect(listener).toHaveBeenCalledTimes(1);

    service.dismiss();
    expect(service.getOffered()).toBeNull();
    // The startup check is not asked again: the offer stays withdrawn until a manual check.
    await service.checkAtStartup();
    expect(service.getOffered()).toBeNull();
    await service.checkNow();
    expect(service.getOffered()).toEqual(UPDATE);

    unsubscribe();
    service.dismiss();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('lets a manual check wait for the startup check still running', async () => {
    let answerStartup: (update: AvailableUpdate | null) => void = () => undefined;
    const check = vi
      .fn<UpdateGateway['check']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerStartup = resolve;
          }),
      )
      .mockResolvedValue(null);
    const service = new UpdateService(stubGateway({ check }), new MemoryLogger());
    void service.checkAtStartup();
    const manual = service.checkNow();
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
    answerStartup(null);
    await expect(manual).resolves.toBeNull();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('swallows a failure to open the release page', async () => {
    const logger = new MemoryLogger();
    const service = new UpdateService(
      stubGateway({ openReleasePage: () => Promise.reject(new Error('no browser')) }),
      logger,
    );
    await expect(service.openReleasePage('0.2.0')).resolves.toBeUndefined();
    expect(logger.entries.at(-1)).toMatchObject({ level: 'warn' });
  });
});
