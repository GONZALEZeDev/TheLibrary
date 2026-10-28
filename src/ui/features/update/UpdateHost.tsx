/**
 * The one update dialog of the app. Mounted once in the shell of the app, beside the pages, it
 * starts the update check of the startup and shows the update the update service offers, whichever
 * check found it: the startup one, or the one of Settings → About. A single dialog, so that the two
 * checks can never open one each.
 *
 * The service asks GitHub once per run of the app at startup (React's development double mount
 * asks nothing more), and a failed startup check shows nothing: the service only logs it. "Later"
 * withdraws the offer until a next check: a change of page never brings it back.
 *
 * @packageDocumentation
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useServices } from '../../app/ServicesContext';
import { UpdateDialog } from './UpdateDialog';

/**
 * Check for a newer version at startup, and show the offered update.
 *
 * @returns The update dialog, open while an update waits for the player's choice.
 */
export function UpdateHost() {
  const { updates } = useServices();
  const update = useSyncExternalStore(updates.subscribe, updates.getOffered);

  useEffect(() => {
    // Never rejects: a failure gives no offer. What it finds reaches `update` through the service.
    void updates.checkAtStartup();
  }, [updates]);

  return (
    <UpdateDialog
      update={update}
      onClose={() => {
        updates.dismiss();
      }}
    />
  );
}
