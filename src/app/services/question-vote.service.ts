import { msg, type Message } from '../i18n/message';
import { Injectable, inject, signal } from '@angular/core';
import { DISLIKE, LIKE, VoteValue } from '../models/question-vote';
import { AuthService } from './auth.service';
import { FirebaseService, MAX_VOTE_READ_IDS } from './firebase.service';

/**
 * What one tap on a vote button came to (`FEAT-027`).
 */
export type VoteOutcome =
  /** The write landed, and `value` is what is now stored — `null` for a removal. */
  | { kind: 'saved'; value: VoteValue | null }
  /**
   * It did not, and the buttons are back to `value`: what is stored, as far as
   * this tab knows. `attempted` is what the tap asked for.
   */
  | { kind: 'failed'; attempted: VoteValue | null; value: VoteValue | null }
  /**
   * A later tap on the same question has been made since, or the account
   * changed while the write was out. Whatever happens next is that tap's to
   * report, so this one says nothing.
   */
  | { kind: 'superseded' }
  /**
   * Nothing was written, because there is no real account to write it under
   * (`FEAT-027` Decision 1): `verify` for a password account whose address is
   * unverified, `sign-in` for everybody else.
   */
  | { kind: 'needs-account'; reason: 'sign-in' | 'verify' };

/**
 * What a screen reader is told about a tap, or `null` for nothing.
 *
 * Every message names the question's position, for the reason the quiz's
 * other live regions do: a region announces only when its text changes, so
 * the same sentence about two different questions would be heard once.
 *
 * A failure says it did not save and to try again, and nothing about why —
 * the write could have been refused, timed out or never left the device, and
 * the client cannot tell which (`CLAUDE.md` §4.4).
 */
export function describeVoteOutcome(outcome: VoteOutcome, position: number): Message | null {
  const n = position;
  switch (outcome.kind) {
    case 'saved':
      if (outcome.value === LIKE) {
        return msg('vote.saidLiked', 'Question {n}: you liked this question.', { n });
      }
      return outcome.value === DISLIKE
        ? msg('vote.saidDisliked', 'Question {n}: you disliked this question.', { n })
        : msg('vote.saidRemoved', 'Question {n}: your vote was removed.', { n });
    case 'failed':
      return outcome.attempted === null
        ? msg(
            'vote.saidRemoveFailed',
            'Question {n}: your vote could not be removed. Please try again.',
            { n },
          )
        : msg(
            'vote.saidSaveFailed',
            'Question {n}: your vote could not be saved. Please try again.',
            { n },
          );
    case 'needs-account':
      return outcome.reason === 'verify'
        ? msg('vote.saidVerify', 'Question {n}: verify your email to like or dislike questions.', {
            n,
          })
        : msg('vote.saidSignIn', 'Question {n}: sign in to like or dislike questions.', { n });
    case 'superseded':
      return null;
  }
}

/** One question's vote, as this tab knows it. */
interface QuestionVoteState {
  /** What the buttons show: the latest tap, before the write behind it has landed. */
  shown: VoteValue | null;
  /** What Firestore holds as far as this tab knows, or `undefined` when it does not know. */
  confirmed: VoteValue | null | undefined;
  /**
   * What the buttons showed before the oldest write still in flight — where a
   * failure returns them when `confirmed` is unknown.
   */
  baseline: VoteValue | null;
  /** How many writes for this question have not settled yet. */
  inFlight: number;
  /** The newest tap's sequence number, so an older write can tell it was overtaken. */
  latest: number;
  /** This question's writes, chained so they reach Firestore in the order they were made. */
  queue: Promise<unknown>;
}

/**
 * The signed-in player's private likes and dislikes for the questions on
 * screen (`FEAT-027`): read once per game, shown on the buttons, and written
 * the moment a button is pressed.
 *
 * **Optimistic, and honest about it.** A tap moves the button at once — it is
 * a like button, and nobody should wait on a round trip for one — and the
 * write follows. If the write fails, the button goes back to what is stored,
 * and the caller is told so it can say it (`describeVoteOutcome`). Writes for
 * one question are chained rather than raced: a like and its removal sent
 * together could land in either order, and the one that landed second would
 * decide what is stored while the button showed the other.
 *
 * **Every write states the outcome it wants rather than a change** — "store a
 * like", "store nothing" — so a retried or reordered write cannot double
 * anything, and the only thing the queue protects is which intent lands last.
 *
 * **Scoped to one account.** The state belongs to the uid that read or wrote
 * it, and is dropped the moment a different one is signed in; a write still
 * out for the previous account reports nothing when it lands.
 */
@Injectable({ providedIn: 'root' })
export class QuestionVoteService {
  private readonly auth = inject(AuthService);
  private readonly firebase = inject(FirebaseService);

  /** Whose votes `states` holds. */
  private owner: string | null = null;
  private states = new Map<string, QuestionVoteState>();
  /** Question ids whose read is in flight for `owner`, so a second caller does not ask twice. */
  private loading = new Set<string>();
  private sequence = 0;

  /**
   * Bumped on every change to what a button would show. The state itself is
   * bookkeeping rather than a signal, so this is how a `computed` over
   * `valueFor` learns it has to re-read.
   */
  private readonly revision = signal(0);

  /**
   * What the buttons for this question should show: `LIKE`, `DISLIKE`, or
   * `null` for no vote.
   *
   * `null` for anybody who cannot vote at all — signed out, anonymous,
   * unverified — and for a different account than the one the state belongs
   * to. That is the least alarming default (`CLAUDE.md` §4.4): an unpressed
   * button claims nothing.
   */
  valueFor(questionId: string): VoteValue | null {
    this.revision();
    const user = this.auth.user();
    if (!user || user.uid !== this.owner || !this.auth.isFullyAuthenticated()) {
      return null;
    }
    return this.states.get(questionId)?.shown ?? null;
  }

  /**
   * Reads the caller's own votes for these questions — one bounded query
   * (`FirebaseService.getOwnQuestionVotes`) — unless they are known already.
   *
   * Does nothing for anybody who cannot vote: an anonymous account cannot have
   * a vote, and the read rule would refuse it. A failed read is not
   * remembered (`CLAUDE.md` §4.4): the buttons show no vote, a tap still works,
   * and the next call asks again.
   */
  async load(questionIds: readonly string[]): Promise<void> {
    const user = this.auth.user();
    if (!user || !this.auth.isFullyAuthenticated()) {
      return;
    }
    const uid = user.uid;
    this.adopt(uid);

    const wanted = [...new Set(questionIds)]
      .filter((id) => !this.states.has(id) && !this.loading.has(id))
      .slice(0, MAX_VOTE_READ_IDS);
    if (wanted.length === 0) {
      return;
    }
    const loading = this.loading;
    for (const id of wanted) {
      loading.add(id);
    }

    try {
      const votes = await this.firebase.getOwnQuestionVotes(uid, wanted);
      if (this.owner !== uid) {
        return;
      }
      for (const id of wanted) {
        // A tap while the read was out wins: the button already shows what
        // the player asked for, and a read sent before that tap is older than
        // the write behind it.
        if (!this.states.has(id)) {
          const value = votes.get(id) ?? null;
          this.states.set(id, {
            shown: value,
            confirmed: value,
            baseline: value,
            inFlight: 0,
            latest: 0,
            queue: Promise.resolve(),
          });
        }
      }
      this.bump();
    } catch (error) {
      console.error('Could not read your votes on these questions', error);
    } finally {
      for (const id of wanted) {
        loading.delete(id);
      }
    }
  }

  /**
   * A press of the like or dislike button on one question.
   *
   * Pressing the button that is already pressed removes the vote; pressing the
   * other one changes it. The buttons move before this returns, and the
   * promise settles when the write behind the tap has.
   */
  toggle(questionId: string, value: VoteValue): Promise<VoteOutcome> {
    const user = this.auth.user();
    if (!user || !this.auth.isFullyAuthenticated()) {
      // A positive fact decides "verify", never the absence of one:
      // `isAnonymous()` reads `false` for a null user (`CLAUDE.md` §4.4).
      const reason = user !== null && !user.isAnonymous ? 'verify' : 'sign-in';
      return Promise.resolve({ kind: 'needs-account', reason });
    }
    const uid = user.uid;
    this.adopt(uid);

    const state = this.stateFor(questionId);
    const target = state.shown === value ? null : value;
    if (state.inFlight === 0) {
      state.baseline = state.shown;
    }
    state.shown = target;
    state.inFlight += 1;
    const sequence = ++this.sequence;
    state.latest = sequence;
    this.bump();

    const write = state.queue.then(() => this.write(uid, questionId, state, target, sequence));
    state.queue = write;
    return write;
  }

  /** Sends one tap's write and settles what the buttons show afterwards. Never rejects. */
  private async write(
    uid: string,
    questionId: string,
    state: QuestionVoteState,
    target: VoteValue | null,
    sequence: number,
  ): Promise<VoteOutcome> {
    let landed = true;
    try {
      // Whether a vote is stored decides the shape of the write, and an
      // unknown answer is sent as "no": the service retries the other shape
      // when the guess was wrong (`FirebaseService.setQuestionVote`).
      await this.firebase.setQuestionVote(uid, questionId, target, state.confirmed != null);
    } catch (error) {
      landed = false;
      console.error('Could not save your vote', error);
    }
    state.inFlight -= 1;

    // The account changed while this was out: the state it belonged to is
    // gone, and nothing on screen is about it any more.
    if (this.owner !== uid || this.states.get(questionId) !== state) {
      return { kind: 'superseded' };
    }
    if (landed) {
      state.confirmed = target;
    }
    if (state.latest !== sequence) {
      return { kind: 'superseded' };
    }
    if (landed) {
      return { kind: 'saved', value: target };
    }
    const restored = state.confirmed === undefined ? state.baseline : state.confirmed;
    state.shown = restored;
    this.bump();
    return { kind: 'failed', attempted: target, value: restored };
  }

  private stateFor(questionId: string): QuestionVoteState {
    let state = this.states.get(questionId);
    if (!state) {
      state = {
        shown: null,
        confirmed: undefined,
        baseline: null,
        inFlight: 0,
        latest: 0,
        queue: Promise.resolve(),
      };
      this.states.set(questionId, state);
    }
    return state;
  }

  /** Makes `uid` the account the state belongs to, dropping everything known about any other. */
  private adopt(uid: string): void {
    if (this.owner === uid) {
      return;
    }
    this.owner = uid;
    this.states = new Map();
    this.loading = new Set();
    this.bump();
  }

  private bump(): void {
    this.revision.update((value) => value + 1);
  }
}
