import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DISLIKE, LIKE, VoteValue } from '../../models/question-vote';
import { QuestionVoteService } from '../../services/question-vote.service';
import { QuestionVoteComponent } from './question-vote.component';

/**
 * `FEAT-027`. What the buttons promise a screen reader and a sighted reader
 * alike: which one is pressed (`aria-pressed` and a filled glyph, never colour
 * alone), what each does (a name that does not change with the state), and
 * that pressing one moves nothing (one box in every state). The write and its
 * announcement are the host's — see the component's comment for why.
 */
@Component({
  standalone: true,
  imports: [QuestionVoteComponent],
  template: `<app-question-vote [questionId]="questionId()" (voted)="pressed.push($event)" />`,
})
class HostComponent {
  readonly questionId = signal('q1');
  readonly pressed: VoteValue[] = [];
}

function setup(initial: Record<string, VoteValue> = {}) {
  const votes = signal<Record<string, VoteValue>>(initial);
  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [
      {
        provide: QuestionVoteService,
        useValue: { valueFor: (questionId: string) => votes()[questionId] ?? null },
      },
    ],
  });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    votes,
    host,
    like: () => host.querySelector<HTMLButtonElement>('[data-cy="vote-like"]')!,
    dislike: () => host.querySelector<HTMLButtonElement>('[data-cy="vote-dislike"]')!,
  };
}

/** Whether a button's glyph is the filled one — the pressed state's change of shape. */
const isFilled = (button: HTMLElement) =>
  button.querySelector('path[fill="currentColor"]') !== null;

afterEach(() => TestBed.resetTestingModule());

describe('QuestionVoteComponent', () => {
  it('is a group labelled by its visible caption', () => {
    const { host } = setup();
    const group = host.querySelector('[data-cy="question-vote"]')!;

    expect(group.getAttribute('role')).toBe('group');
    const caption = host.querySelector(`#${group.getAttribute('aria-labelledby')}`);
    expect(caption?.textContent?.trim()).toBe('Rate this question');
  });

  it('shows neither pressed when there is no vote', () => {
    const { like, dislike } = setup();

    expect(like().getAttribute('aria-pressed')).toBe('false');
    expect(dislike().getAttribute('aria-pressed')).toBe('false');
    expect(isFilled(like())).toBe(false);
    expect(isFilled(dislike())).toBe(false);
  });

  it('shows the stored vote as pressed, and fills its glyph', () => {
    const { like, dislike } = setup({ q1: DISLIKE });

    expect(dislike().getAttribute('aria-pressed')).toBe('true');
    expect(isFilled(dislike())).toBe(true);
    expect(like().getAttribute('aria-pressed')).toBe('false');
    expect(isFilled(like())).toBe(false);
  });

  it('follows the vote as it changes', () => {
    const { fixture, votes, like } = setup();

    votes.set({ q1: LIKE });
    fixture.detectChanges();

    expect(like().getAttribute('aria-pressed')).toBe('true');
    expect(isFilled(like())).toBe(true);
  });

  it('reads the vote for whichever question it is given', () => {
    const { fixture, like } = setup({ q2: LIKE });

    fixture.componentInstance.questionId.set('q2');
    fixture.detectChanges();

    expect(like().getAttribute('aria-pressed')).toBe('true');
  });

  it('reports which button was pressed, and writes nothing itself', () => {
    const { fixture, like, dislike } = setup();

    like().click();
    dislike().click();

    expect(fixture.componentInstance.pressed).toEqual([LIKE, DISLIKE]);
  });

  // A toggle button's name is what it does; `aria-pressed` is what it is.
  // Changing both would announce the state twice.
  it('keeps each button’s name whether or not it is pressed', () => {
    const { fixture, votes, like, dislike } = setup();
    const before = [like().getAttribute('aria-label'), dislike().getAttribute('aria-label')];

    votes.set({ q1: LIKE });
    fixture.detectChanges();

    expect([like().getAttribute('aria-label'), dislike().getAttribute('aria-label')]).toEqual(
      before,
    );
    expect(before).toEqual(['Like this question', 'Dislike this question']);
  });

  /**
   * jsdom has no layout, so the box itself is measured in the e2e suite. What
   * is pinned here is the mechanism: the same fixed size in either state, so
   * nothing about pressing a button can change its dimensions.
   */
  it('gives both buttons the same fixed box in every state', () => {
    const { fixture, votes, like, dislike } = setup();
    const sizes = () =>
      [like(), dislike()].map((button) =>
        ['h-10', 'w-10', 'border-[1.5px]'].every((token) => button.classList.contains(token)),
      );

    expect(sizes()).toEqual([true, true]);
    votes.set({ q1: LIKE });
    fixture.detectChanges();
    expect(sizes()).toEqual([true, true]);
    votes.set({ q1: DISLIKE });
    fixture.detectChanges();
    expect(sizes()).toEqual([true, true]);
  });

  it('gives each instance its own caption id', () => {
    const first = setup().host.querySelector('[data-cy="question-vote"]')!;
    const firstId = first.getAttribute('aria-labelledby');
    TestBed.resetTestingModule();
    const second = setup().host.querySelector('[data-cy="question-vote"]')!;

    expect(second.getAttribute('aria-labelledby')).not.toBe(firstId);
  });
});
