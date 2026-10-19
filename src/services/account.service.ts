/**
 * The Steam account linked to the app: linking it, switching to another, unlinking it with its data,
 * and the upkeep of the link (the cleanup at startup, the daily refresh of the profile).
 *
 * This is the only writer of the link. It does not know how a sign-in works (`SteamSignInService`),
 * how a profile is fetched (`SteamProfileService`) nor how data is deleted (`AccountDataService`):
 * it decides *when* each happens, and in which order, because it deletes the user's data.
 *
 * - **Nothing is deleted before the link has changed.** A switch saves the new link, then erases the
 *   old account; an unlink clears the link, then erases the account. A crash in between leaves data
 *   that belongs to no linked account, which the cleanup at the next start deletes. The other order
 *   could leave a link to an account without data. The one thing saved *before* the link changes is
 *   the debt of a compaction of the database (see `AccountDataService.prepareErasure`): the link row
 *   holds the persona name and the avatar, and an account that has no data yet would otherwise leave
 *   the next start nothing to tell it to compact.
 * - **Nothing writes for an account while it is erased.** The synchronisation is suspended before the
 *   link changes (which waits for the run going to end) and resumed in a `finally`, whatever
 *   happened: a failure must never leave the app synchronising nothing for good. The cleanup at
 *   startup is no exception: the interface can ask for a synchronisation before the app has started
 *   its own, so the cleanup runs suspended too.
 * - **One operation at a time.** Suspensions are not counted by the synchronisation, so two
 *   operations in parallel could resume it under each other. Every operation (a link, an unlink, the
 *   cleanup at startup, a refresh of the profile) therefore waits for the one before it on a promise
 *   chain, and a failed operation never breaks the chain for the next.
 *
 * Privacy: a line of the log never holds an account id, a SteamID64, a persona name, a URL or the
 * message of an error. The only errors logged with their details are failures of the database (see
 * {@link failureContext}).
 *
 * @packageDocumentation
 */
import { isProfileRefreshDue, type LinkedAccount } from '../core/account/linked-account';
import type { AccountId } from '../core/domain/account';
import { errorLogContext, toAppError, type AppErrorContext } from '../core/errors/app-error';
import type { LogContext, Logger, LogLevel } from '../ports/logger.port';
import type { AccountDataService } from './account-data.service';
import type { LinkedAccountRepository } from './linked-account.repository';
import {
  NO_PROFILE,
  type ProfileSnapshot,
  type SteamProfileService,
} from './steam-profile.service';
import type { SignInOutcome, SteamSignInService } from './steam-sign-in.service';
import type { SyncService } from './sync.service';

/** Scope of every log line of this service. */
const LOG_SCOPE = 'account';

/**
 * How a link ended:
 *
 * - `linked`: the player signed in with an account, now the linked one. `replaced` tells whether it
 *   took the place of another, whose data was then erased;
 * - `already_linked`: the player signed in with the account that is linked already. Nothing changed
 *   but its profile, which was refreshed;
 * - any other outcome of the sign-in (cancelled, timed out, refused…): nothing changed.
 */
export type LinkResult =
  | { readonly kind: 'linked'; readonly account: LinkedAccount; readonly replaced: boolean }
  | { readonly kind: 'already_linked'; readonly account: LinkedAccount }
  | Exclude<SignInOutcome, { readonly kind: 'signed_in' }>;

/** How an unlink went. */
export interface UnlinkResult {
  /**
   * `true` when everything of the account is gone. `false` when something may be left (a file that
   * could not be removed, say): the account is unlinked all the same, and the cleanup at the next
   * start finishes the deletion.
   */
  readonly complete: boolean;
}

/** What {@link AccountService} needs. */
export interface AccountServiceDependencies {
  /** The stored link: the only place this service reads and writes the account. */
  readonly accounts: LinkedAccountRepository;
  /** Signs the player in with Steam. */
  readonly signIn: SteamSignInService;
  /** Fetches the persona name and the avatar. */
  readonly profiles: SteamProfileService;
  /** Deletes the data of an account. */
  readonly data: AccountDataService;
  /** The synchronisation, suspended while the account changes. */
  readonly sync: SyncService;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/**
 * Turn what a failed step threw into the context of a log line. A failure of the database is logged
 * with all its details, as everywhere else; any other failure by its kind only, since the message of
 * an unexpected error could quote anything.
 *
 * @param error - What was thrown.
 * @returns The context to log.
 */
function failureContext(error: unknown): AppErrorContext {
  const appError = toAppError(error);
  return appError.kind === 'storage' ? errorLogContext(appError) : { kind: appError.kind };
}

/**
 * The fields of a profile snapshot, read from the snapshot itself: `NO_PROFILE` has every field of
 * its type, so a field added to `ProfileSnapshot` is compared here without anyone remembering to.
 */
const PROFILE_FIELDS = Object.keys(NO_PROFILE) as readonly (keyof ProfileSnapshot)[];

/**
 * Tell whether a profile fetched is the profile the link already holds.
 *
 * @param link - The linked account.
 * @param profile - What the profile service gave for it.
 * @returns `true` when there is nothing new to store.
 */
function isSameProfile(link: LinkedAccount, profile: ProfileSnapshot): boolean {
  return PROFILE_FIELDS.every((field) => link[field] === profile[field]);
}

/** Links, switches and unlinks the Steam account. */
export class AccountService {
  /**
   * Be told when the linked account changes (linked, switched, unlinked, or its profile updated), in
   * the shape of `useSyncExternalStore`. It is the repository's own subscription: the listener reads
   * the account again if it needs it.
   */
  readonly subscribe: (listener: () => void) => () => void;

  readonly #accounts: LinkedAccountRepository;
  readonly #signIn: SteamSignInService;
  readonly #profiles: SteamProfileService;
  readonly #data: AccountDataService;
  readonly #sync: SyncService;
  readonly #logger: Logger;
  readonly #now: () => number;

  /** The end of the chain of operations: it settles once the last one queued is over. */
  #tail: Promise<void> = Promise.resolve();
  /** How many operations are running or queued. */
  #queued = 0;
  /** The link in progress (waiting for its turn or signing in), shared by every caller. */
  #pendingLink: Promise<LinkResult> | null = null;
  /** Whether the player gave up the pending link: set by `cancelLink`, read when the link starts. */
  #linkCancelled = false;
  /** The startup, once it was asked for. */
  #started: Promise<void> | null = null;

  /**
   * @param dependencies - See {@link AccountServiceDependencies}.
   */
  constructor(dependencies: AccountServiceDependencies) {
    this.#accounts = dependencies.accounts;
    this.#signIn = dependencies.signIn;
    this.#profiles = dependencies.profiles;
    this.#data = dependencies.data;
    this.#sync = dependencies.sync;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
    this.subscribe = dependencies.accounts.subscribe;
  }

  /**
   * Start the app's work for the linked account: delete what does not belong to it, then start the
   * synchronisation.
   *
   * The cleanup comes first, with the synchronisation suspended: nothing may write for an account
   * while its data is deleted, and the synchronisation is not gated on this method (the "Sync"
   * button and the retry of a match detail can start a run before the app has started its own). When
   * the link cannot be read the cleanup is skipped, and the synchronisation starts all the same: an
   * unreadable link is not "no account", and deleting everything on that guess would destroy the
   * data of the account the app lost.
   *
   * The profile of the account is refreshed after a synchronisation when it is due (see
   * {@link AccountService.refreshProfileIfDue}). Calling it again has no effect.
   *
   * @returns A promise resolved once the synchronisation is started; it never rejects.
   */
  start(): Promise<void> {
    this.#started ??= this.#enqueue(() => this.#startUp());
    return this.#started;
  }

  /**
   * The linked account.
   *
   * @returns The account, or `null` when none is linked.
   * @throws AppError of kind `storage` when the database fails or the stored link is invalid.
   */
  getLinkedAccount(): Promise<LinkedAccount | null> {
    return this.#accounts.getLinkedAccount();
  }

  /**
   * Link a Steam account: sign the player in, fetch their profile and store it. The account that
   * was linked, if it is another one, is erased once the new link is saved (a switch).
   *
   * A call made while a link is in progress gets that link's result and starts nothing, so a player
   * who clicks twice opens one browser tab. A link waits for the operation before it, if any.
   *
   * @returns How it ended. Anything but `linked` and `already_linked` changed nothing.
   * @throws AppError of kind `storage` when the stored link cannot be read, or the new link cannot be
   *   saved; nothing is deleted then.
   */
  link(): Promise<LinkResult> {
    if (this.#pendingLink === null) {
      this.#linkCancelled = false;
      this.#pendingLink = this.#enqueue(() => this.#link()).finally(() => {
        this.#pendingLink = null;
      });
    }
    return this.#pendingLink;
  }

  /**
   * Give up the pending link: the player closed the dialog or pressed Escape. Nothing happens when
   * no link is pending.
   *
   * A link that has not had its turn yet (another operation is in front of it) ends without opening
   * the browser; one that is signing in is cancelled; one that is past the sign-in goes on, since
   * Steam already confirmed the player.
   */
  cancelLink(): void {
    if (this.#pendingLink === null) {
      return;
    }
    this.#linkCancelled = true;
    this.#signIn.cancel();
  }

  /**
   * Unlink the account and delete all of its local data. The link is cleared first, then the account
   * is erased with the synchronisation suspended: see the header of the file.
   *
   * The id of the account is read without its profile, so a link whose persona name or avatar is
   * damaged can always be unlinked.
   *
   * @returns Whether everything was deleted (`complete`). With no account linked, there is nothing
   *   to do and it is `true`.
   * @throws AppError of kind `storage` when the link cannot be read or cleared; nothing is deleted
   *   then, and the synchronisation is resumed.
   */
  unlink(): Promise<UnlinkResult> {
    return this.#enqueue(() => this.#unlink());
  }

  /**
   * Fetch the profile of the linked account again if it is due (see `isProfileRefreshDue`), and
   * store it if it changed. A profile that cannot be fetched stays as it is and is tried again at
   * the next call.
   *
   * It does nothing when another operation is running or queued, however due the profile is: the
   * operation may change the account, and the next synchronisation asks again.
   *
   * @returns A promise resolved once it is done; it never rejects. A failure is logged.
   */
  async refreshProfileIfDue(): Promise<void> {
    if (this.#queued > 0) {
      return;
    }
    try {
      await this.#enqueue(() => this.#refreshProfile());
    } catch (error) {
      this.#log(
        'warn',
        'The profile of the linked account could not be refreshed',
        failureContext(error),
      );
    }
  }

  /**
   * Run an operation once the ones before it are over.
   *
   * The chain goes on whether the operation succeeded or failed: its failure is its caller's, not
   * the next operation's.
   *
   * @param operation - What to run.
   * @returns A promise of the operation's result, rejected with its failure.
   */
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.#queued += 1;
    const result = this.#tail.then(operation).finally(() => {
      this.#queued -= 1;
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * The startup: the cleanup, then the synchronisation and the refreshes of the profile.
   */
  async #startUp(): Promise<void> {
    // Suspended around the cleanup, like around an erasure (this waits for a run the interface may
    // have started). `resume()` starts no timer, since none was wanted yet: `start()` below then
    // gives the `startup` run and the timer, exactly as without the suspension.
    await this.#sync.suspend();
    try {
      await this.#sweep();
    } finally {
      this.#sync.resume();
    }
    // Told when a run ends, not when it starts or has saved its history: the profile is refreshed
    // between two runs, never under one.
    this.#sync.subscribe(() => {
      if (!this.#sync.isRunning()) {
        void this.refreshProfileIfDue();
      }
    });
    this.#sync.start();
  }

  /** Delete what does not belong to the linked account, unless the link cannot be read. */
  async #sweep(): Promise<void> {
    let linked: AccountId | null;
    try {
      linked = await this.#accounts.currentAccountId();
    } catch (error) {
      this.#log(
        'error',
        'The linked account cannot be read: nothing is deleted',
        failureContext(error),
      );
      return;
    }
    await this.#data.sweep(linked);
  }

  /**
   * Sign the player in, then store the account they signed in with.
   *
   * @returns How the link ended.
   */
  async #link(): Promise<LinkResult> {
    const previous = await this.#accounts.getLinkedAccount();
    // The player may have given up while the link waited for its turn or the link was read.
    if (this.#linkCancelled) {
      return { kind: 'cancelled' };
    }
    const outcome = await this.#signIn.signIn();
    if (outcome.kind !== 'signed_in') {
      return outcome;
    }
    if (previous !== null && previous.accountId === outcome.accountId) {
      return this.#linkAgain(previous);
    }
    return this.#linkNew(outcome.accountId, previous);
  }

  /**
   * The player signed in with the account that is linked already: refresh its profile and delete
   * nothing. No refresh request is spent on Steam (`allowRefresh`), which is for a new account.
   *
   * @param previous - The linked account.
   * @returns `already_linked`.
   */
  async #linkAgain(previous: LinkedAccount): Promise<LinkResult> {
    const profile = await this.#profiles.fetchProfile(previous.accountId, previous, {
      allowRefresh: false,
    });
    const account: LinkedAccount = { ...previous, ...profile };
    await this.#accounts.setLinkedAccount(account);
    this.#log('info', 'Steam account already linked');
    return { kind: 'already_linked', account };
  }

  /**
   * The player signed in with an account that is not the linked one: link it, and erase the account
   * it replaces.
   *
   * @param accountId - The account the player signed in with.
   * @param previous - The linked account it replaces, or `null` when none was linked.
   * @returns `linked`.
   */
  async #linkNew(accountId: AccountId, previous: LinkedAccount | null): Promise<LinkResult> {
    // The profile is fetched before the synchronisation is suspended: it takes network time, and it
    // touches nothing of the old account. One refresh request may be spent on Steam, for this link.
    const profile = await this.#profiles.fetchProfile(accountId, NO_PROFILE, {
      allowRefresh: true,
    });
    const account: LinkedAccount = { accountId, ...profile, linkedAt: this.#now() };
    if (previous === null) {
      // Nothing is erased here. If an unlink of this session was incomplete (a file could not be
      // removed) and the same account links again, what that unlink left is kept as the account's
      // data: the next startup cleanup spares it, as the data of the linked account. Whatever it
      // left of any other account is deleted by that cleanup.
      await this.#accounts.setLinkedAccount(account);
    } else {
      await this.#switchTo(account, previous.accountId);
    }
    // The first synchronisation of the account, asked for by the player: not awaited, the link is
    // done. The synchronisation is not suspended any more, so the run is not refused.
    void this.#sync.syncNow('link');
    const replaced = previous !== null;
    this.#log('info', 'Steam account linked', {
      replaced,
      profile: account.personaName === null ? 'placeholder' : 'found',
    });
    return { kind: 'linked', account, replaced };
  }

  /**
   * Save the new link, then erase the old account, with the synchronisation suspended. The debt of
   * the compaction is saved before the link.
   *
   * @param account - The account to link.
   * @param replacedId - The account it replaces.
   * @throws AppError of kind `storage` when the new link cannot be saved. Nothing is erased then:
   *   the erasure comes after the link, in the same `try`. The debt stays saved, and only costs one
   *   compaction at the next start.
   */
  async #switchTo(account: LinkedAccount, replacedId: AccountId): Promise<void> {
    await this.#sync.suspend();
    try {
      // The compaction is owed from here, before the link row changes: an app killed right after
      // the change, for an old account that has no data yet, would otherwise leave its persona name
      // and avatar in the free pages of the database, with no debt to tell the next start. If the
      // change fails, nothing is deleted and the debt only costs one compaction at the next start.
      // Never rejects: a flag that cannot be saved is logged.
      await this.#data.prepareErasure();
      await this.#accounts.setLinkedAccount(account);
      // Never rejects: what could not be deleted is logged, and the next start's cleanup retries.
      await this.#data.eraseAccount(replacedId);
    } finally {
      this.#sync.resume();
    }
  }

  /**
   * Clear the link, then erase the account, with the synchronisation suspended. The debt of the
   * compaction is saved before the link is cleared.
   *
   * @returns Whether everything was deleted.
   * @throws AppError of kind `storage` when the link cannot be cleared. Nothing is erased then; the
   *   debt stays saved, and only costs one compaction at the next start.
   */
  async #unlink(): Promise<UnlinkResult> {
    const accountId = await this.#accounts.currentAccountId();
    if (accountId === null) {
      return { complete: true };
    }
    await this.#sync.suspend();
    let complete: boolean;
    try {
      // The compaction is owed before the link is cleared, for the reason given in `#switchTo`: the
      // link row holds the persona name and the avatar. Never rejects.
      await this.#data.prepareErasure();
      await this.#accounts.clearLinkedAccount();
      ({ complete } = await this.#data.eraseAccount(accountId));
    } finally {
      this.#sync.resume();
    }
    this.#log('info', 'Steam account unlinked', { complete });
    return { complete };
  }

  /** Fetch the profile of the linked account if it is due, and store it if it changed. */
  async #refreshProfile(): Promise<void> {
    // Read again inside the chain: the account may have changed since the refresh was asked for.
    const link = await this.#accounts.getLinkedAccount();
    if (link === null || !isProfileRefreshDue(link, this.#now())) {
      return;
    }
    const profile = await this.#profiles.fetchProfile(link.accountId, link, {
      allowRefresh: false,
    });
    if (!isSameProfile(link, profile)) {
      await this.#accounts.setLinkedAccount({ ...link, ...profile });
    }
  }

  /**
   * Write one line in this service's scope.
   *
   * @param level - Severity.
   * @param message - What happened.
   * @param context - Details. Never an account id, a name, a URL or an error's message: a failure
   *   goes through {@link failureContext}.
   */
  #log(level: LogLevel, message: string, context?: LogContext): void {
    this.#logger.log(level, LOG_SCOPE, message, context);
  }
}
