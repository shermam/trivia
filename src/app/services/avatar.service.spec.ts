import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AvatarChoice } from '../models/avatar.model';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { AvatarService } from './avatar.service';
import { FirestoreRestClient, RestDocument } from './firestore-rest/firestore-rest.client';

/**
 * `AvatarService` (`FEAT-038`): one read per account per session, only for a
 * real account, and a save that lands everywhere at once. The chip is on every
 * page, so a read here is a read on every page load — what is pinned is that
 * it happens exactly when it must and not otherwise.
 */

interface FakeUser {
  uid: string;
  isAnonymous: boolean;
  photoURL?: string | null;
}

function setup(
  options: { user?: FakeUser | null; document?: RestDocument | null; fails?: boolean } = {},
) {
  const userSignal = signal<FakeUser | null>(options.user === undefined ? null : options.user);
  const batchGetDocument = vi.fn((path: string) => {
    void path;
    return options.fails
      ? Promise.reject(new Error('refused'))
      : Promise.resolve(options.document === undefined ? null : options.document);
  });
  const setAvatar = vi.fn((choice: AvatarChoice) => Promise.resolve(choice));

  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { user: userSignal } },
      { provide: FirestoreRestClient, useValue: { batchGetDocument } },
      { provide: AccountService, useValue: { setAvatar } },
    ],
  });
  const service = TestBed.inject(AvatarService);
  return { service, userSignal, batchGetDocument, setAvatar };
}

/** Runs the effect, then lets the read's promise settle. */
async function settle(): Promise<void> {
  TestBed.tick();
  await Promise.resolve();
  await Promise.resolve();
  TestBed.tick();
}

const account = (uid = 'player-1'): FakeUser => ({ uid, isAnonymous: false });
const document = (data: Record<string, unknown>): RestDocument => ({
  id: 'player-1',
  path: 'users/player-1',
  data,
});

/** Where the device keeps its copy — `AvatarService`'s `CACHE_KEY`. */
const CACHE_KEY = 'trivia-avatar';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // Spec files share a jsdom between them (`--isolate` is off), so the copy is
  // cleared on the way in as well as on the way out.
  localStorage.removeItem(CACHE_KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(CACHE_KEY);
  TestBed.resetTestingModule();
});

describe('AvatarService', () => {
  it('reads the stored choice once a real account is signed in', async () => {
    const { service, batchGetDocument } = setup({
      user: account(),
      document: document({ avatar: { kind: 'built', seed: 'core-35', showPublicly: false } }),
    });

    await settle();

    expect(batchGetDocument).toHaveBeenCalledTimes(1);
    expect(batchGetDocument.mock.calls[0][0]).toBe('users/player-1');
    expect(service.status()).toBe('ready');
    expect(service.choice()).toEqual({ kind: 'built', seed: 'core-35', showPublicly: false });
  });

  /**
   * A guest is answered without a request: there is no `users/{uid}` for an
   * anonymous session and never will be, and the chip is on every page — a
   * read here would be a billed request on every visitor's every page load to
   * learn nothing.
   */
  it('reads nothing for an anonymous session, or for nobody', async () => {
    const { service, batchGetDocument, userSignal } = setup({ user: null });
    await settle();
    expect(service.status()).toBe('none');

    userSignal.set({ uid: 'guest', isAnonymous: true });
    await settle();

    expect(batchGetDocument).not.toHaveBeenCalled();
    expect(service.status()).toBe('none');
    expect(service.choice()).toBeNull();
  });

  it('does not read again when the same account is re-emitted', async () => {
    const { batchGetDocument, userSignal } = setup({ user: account(), document: null });
    await settle();

    userSignal.set({ ...account() });
    await settle();

    expect(batchGetDocument).toHaveBeenCalledTimes(1);
  });

  /**
   * The default for a document that never set the switch is "not public" —
   * the owner's condition on the feature, pinned through the service as well
   * as through the reader it uses.
   */
  it('reads an account with no document as initials, and not public', async () => {
    const { service } = setup({ user: account(), document: null });
    await settle();

    expect(service.status()).toBe('ready');
    expect(service.choice()).toEqual({ kind: 'initials', showPublicly: false });
  });

  it('reads a totals document that never set an avatar the same way', async () => {
    const { service } = setup({ user: account(), document: document({ gamesPlayed: 4 }) });
    await settle();

    expect(service.choice()).toEqual({ kind: 'initials', showPublicly: false });
  });

  /**
   * A failed read is not "initials": the chip draws initials meanwhile anyway,
   * but the picker must not present the default as the stored choice.
   */
  it('reports a failed read as failed, and recovers on retry', async () => {
    const { service, batchGetDocument } = setup({ user: account(), fails: true });
    await settle();

    expect(service.status()).toBe('failed');
    expect(service.choice()).toBeNull();

    batchGetDocument.mockImplementation(() =>
      Promise.resolve(document({ avatar: { kind: 'photo', showPublicly: true } })),
    );
    service.retry();
    expect(service.status()).toBe('loading');
    await settle();

    expect(service.status()).toBe('ready');
    expect(service.choice()).toEqual({ kind: 'photo', showPublicly: true });
  });

  it('forgets the previous account on sign-out, and reads the next one', async () => {
    const { service, userSignal, batchGetDocument } = setup({
      user: account('first'),
      document: document({ avatar: { kind: 'built', seed: 'core-00', showPublicly: false } }),
    });
    await settle();
    expect(service.choice()?.kind).toBe('built');

    userSignal.set(null);
    await settle();
    expect(service.choice()).toBeNull();

    userSignal.set(account('second'));
    await settle();
    expect(batchGetDocument).toHaveBeenLastCalledWith('users/second', expect.anything());
  });

  it('drops an answer that arrives after the account has changed', async () => {
    let release!: (value: RestDocument | null) => void;
    const { service, userSignal, batchGetDocument } = setup({ user: account('first') });
    batchGetDocument.mockImplementation(
      () => new Promise<RestDocument | null>((resolve) => (release = resolve)),
    );
    await settle();

    userSignal.set(null);
    await settle();
    release(document({ avatar: { kind: 'built', seed: 'core-00', showPublicly: false } }));
    await settle();

    expect(service.choice()).toBeNull();
    expect(service.status()).toBe('none');
  });

  /**
   * The photo is read from the Firebase user at render time and never stored —
   * and narrowed to the one host the CSP admits.
   */
  it('offers the account’s photo only when it is on Google’s image host', async () => {
    const { service, userSignal } = setup({
      user: { ...account(), photoURL: 'https://lh3.googleusercontent.com/a/x' },
    });
    expect(service.photoUrl()).toBe('https://lh3.googleusercontent.com/a/x');

    userSignal.set({ ...account(), photoURL: 'https://graph.facebook.com/1/picture' });
    expect(service.photoUrl()).toBeNull();
  });

  /**
   * The device's copy (`FEAT-038`): offline, and on every load before the read
   * lands, a built avatar is drawn from it rather than initials — because the
   * spec wants a built avatar rendered from bundled assets offline. It is UX,
   * never authority: shown only for the account it names, replaced by the
   * server's answer, and never what the picker opens on (`status` stays
   * `loading` until the server answers).
   */
  describe('the copy on this device', () => {
    const built = { kind: 'built', seed: 'core-35', showPublicly: false } as const;
    const store = (uid: string, choice: unknown) =>
      localStorage.setItem(CACHE_KEY, JSON.stringify({ uid, choice }));

    it('draws the copy until the server answers, then the server’s answer', async () => {
      store('player-1', built);
      let release!: (value: RestDocument | null) => void;
      const { service, batchGetDocument } = setup({ user: account() });
      batchGetDocument.mockImplementation(
        () => new Promise<RestDocument | null>((resolve) => (release = resolve)),
      );
      await settle();

      expect(service.choice()).toEqual(built);
      expect(service.status()).toBe('loading');

      release(document({ avatar: { kind: 'initials', showPublicly: true } }));
      await settle();

      expect(service.choice()).toEqual({ kind: 'initials', showPublicly: true });
      expect(service.status()).toBe('ready');
      // ...and the copy now says what the server said.
      expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toEqual({
        uid: 'player-1',
        choice: { kind: 'initials', showPublicly: true },
      });
    });

    it('keeps drawing the copy when the read fails, as it does offline', async () => {
      store('player-1', built);
      const { service } = setup({ user: account(), fails: true });
      await settle();

      expect(service.status()).toBe('failed');
      expect(service.choice()).toEqual(built);
    });

    it('never draws one account’s copy for another', async () => {
      store('somebody-else', built);
      const { service } = setup({ user: account(), fails: true });
      await settle();

      expect(service.choice()).toBeNull();
    });

    it('writes the copy when the server answers', async () => {
      setup({
        user: account(),
        document: document({ avatar: { kind: 'built', seed: 'core-12', showPublicly: false } }),
      });
      await settle();

      expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toEqual({
        uid: 'player-1',
        choice: { kind: 'built', seed: 'core-12', showPublicly: false },
      });
    });

    /**
     * The next person at this browser is never drawn as the last one. The
     * frames before auth has restored a session are "nobody yet", not a
     * sign-out, so they leave the copy alone — or it would never be drawn.
     */
    it('removes the copy on sign-out, and only on sign-out', async () => {
      store('player-1', built);
      const { service, userSignal } = setup({ user: null, fails: true });
      await settle();
      expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();

      userSignal.set(account());
      await settle();
      expect(service.choice()).toEqual(built);

      userSignal.set(null);
      await settle();
      expect(localStorage.getItem(CACHE_KEY)).toBeNull();
      expect(service.choice()).toBeNull();
    });

    it('reads a copy someone has edited the way it reads the server', async () => {
      store('player-1', { kind: 'built', seed: '../x.png', showPublicly: 'yes' });
      const { service } = setup({ user: account(), fails: true });
      await settle();

      expect(service.choice()).toEqual({ kind: 'initials', showPublicly: false });
    });

    it('carries on without one when storage cannot be read', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const { service } = setup({ user: account(), document: null });
      await settle();

      expect(service.status()).toBe('ready');
      expect(service.choice()).toEqual({ kind: 'initials', showPublicly: false });
    });
  });

  describe('save', () => {
    it('stores the choice and shows what the callable kept, without reading again', async () => {
      const { service, setAvatar, batchGetDocument } = setup({ user: account(), document: null });
      await settle();

      const choice: AvatarChoice = { kind: 'built', seed: 'core-41', showPublicly: true };
      expect(await service.save(choice)).toBe('saved');

      expect(setAvatar).toHaveBeenCalledWith(choice);
      expect(service.choice()).toEqual(choice);
      expect(batchGetDocument).toHaveBeenCalledTimes(1);
    });

    /**
     * Cloud Functions are not channel-scoped, so on a preview channel a new
     * callable does not exist yet and retrying can never succeed. That case is
     * told apart, so the picker does not tell the reader to try again.
     */
    it('tells a callable that does not exist yet apart from a failure', async () => {
      const { service, setAvatar } = setup({ user: account(), document: null });
      await settle();

      setAvatar.mockRejectedValueOnce(
        new Error('not here', { cause: { code: 'functions/not-found' } }),
      );
      expect(await service.save({ kind: 'initials', showPublicly: false })).toBe('unavailable');

      setAvatar.mockRejectedValueOnce(new Error('down', { cause: { code: 'functions/internal' } }));
      expect(await service.save({ kind: 'initials', showPublicly: false })).toBe('failed');

      // A failed save leaves what was stored alone.
      expect(service.choice()).toEqual({ kind: 'initials', showPublicly: false });
    });

    /**
     * **A timeout is not a failure.** The callable SDK's `timeout` stops
     * waiting and cancels nothing — `@firebase/functions` races a timer against
     * a `fetch` it gives no abort signal — so a timed-out write may have
     * landed. The stored choice is read back before anything is said.
     */
    it('reads the choice back after a timeout, and reports the save if it landed', async () => {
      const { service, setAvatar, batchGetDocument } = setup({ user: account(), document: null });
      await settle();
      const choice: AvatarChoice = { kind: 'built', seed: 'core-41', showPublicly: false };

      setAvatar.mockRejectedValueOnce(
        new Error('slow', { cause: { code: 'functions/deadline-exceeded' } }),
      );
      batchGetDocument.mockResolvedValueOnce(document({ avatar: choice }));

      expect(await service.save(choice)).toBe('saved');
      expect(batchGetDocument).toHaveBeenCalledTimes(2);
      expect(service.choice()).toEqual(choice);
    });

    it('reports a timed-out save as unconfirmed — never as not saved — when it has not landed', async () => {
      const { service, setAvatar, batchGetDocument } = setup({ user: account(), document: null });
      await settle();
      const timeout = () => new Error('slow', { cause: { code: 'functions/deadline-exceeded' } });

      setAvatar.mockRejectedValueOnce(timeout());
      expect(await service.save({ kind: 'photo', showPublicly: false })).toBe('unconfirmed');
      // What is shown stays what the server holds, so the picker keeps the
      // reader's choice for another try.
      expect(service.choice()).toEqual({ kind: 'initials', showPublicly: false });

      setAvatar.mockRejectedValueOnce(timeout());
      batchGetDocument.mockRejectedValueOnce(new Error('offline'));
      expect(await service.save({ kind: 'photo', showPublicly: false })).toBe('unconfirmed');
    });

    it('refuses to save for nobody', async () => {
      const { service, setAvatar } = setup({ user: { uid: 'guest', isAnonymous: true } });
      await settle();

      expect(await service.save({ kind: 'initials', showPublicly: false })).toBe('failed');
      expect(setAvatar).not.toHaveBeenCalled();
    });
  });
});
