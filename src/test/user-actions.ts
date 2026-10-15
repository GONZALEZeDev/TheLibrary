/**
 * Test helpers for the user actions that several screens share.
 *
 * @packageDocumentation
 */
import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

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
