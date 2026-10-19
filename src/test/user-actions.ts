/**
 * Test helpers for the user actions, and the waits, that several screens share.
 *
 * @packageDocumentation
 */
import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';
import type { SyncService } from '../services/sync.service';

/**
 * Click the synchronisation button once it can be clicked. It is disabled until the status is
 * loaded, and a click on a disabled button does nothing: finding the button is not enough.
 *
 * @param user - The simulated user.
 * @param label - Name of the button, in the language of the interface.
 */
export async function clickSyncNow(user: UserEvent, label = 'Sync now'): Promise<void> {
  const button = await screen.findByRole('button', { name: label });
  await waitFor(() => {
    expect(button).toBeEnabled();
  });
  await user.click(button);
}

/**
 * Wait until the synchronisation has ended, background work included: the detail queue is part of
 * it, and a test must not end under it.
 *
 * @param sync - The synchronisation.
 * @param timeout - How long to wait, in milliseconds; the default of Testing Library (one second)
 *   when missing. A test that waits for a chain of services (a sign-in, then the first
 *   synchronisation) gives the time it gave to the rest of the chain.
 */
export async function waitUntilIdle(sync: SyncService, timeout?: number): Promise<void> {
  await waitFor(
    () => {
      expect(sync.isRunning()).toBe(false);
    },
    // `exactOptionalPropertyTypes` forbids passing an explicit `undefined` timeout.
    timeout === undefined ? {} : { timeout },
  );
}
