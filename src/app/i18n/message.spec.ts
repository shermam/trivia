import {
  MessageError,
  englishText,
  messageOf,
  msg,
  renderParams,
  sameMessage,
  verbatim,
} from './message';

describe('Message', () => {
  it('builds a message with its key, its English and its params', () => {
    expect(msg('setup.start', 'Start Game')).toEqual({ key: 'setup.start', en: 'Start Game' });
    expect(
      msg('quiz.questions', '{n, plural, one {# question} other {# questions}}', { n: 2 }),
    ).toEqual({
      key: 'quiz.questions',
      en: '{n, plural, one {# question} other {# questions}}',
      params: { n: 2 },
    });
  });

  it('shows verbatim text as it is, through the one key every language maps to itself', () => {
    const text = verbatim('Stripe says: {no}');
    expect(text.key).toBe('i18n.verbatim');
    expect(englishText(text)).toBe('Stripe says: {no}');
  });

  it('renders a message param in the language of the message around it, and a list joined', () => {
    const inner = msg('quiz.questions', '{n, plural, one {# question} other {# questions}}', {
      n: 1,
    });
    const rendered = renderParams(
      { n: 3, what: inner, list: [verbatim('a'), verbatim('b')] },
      (message) => `<${englishText(message)}>`,
    );
    expect(rendered).toEqual({ n: 3, what: '<1 question>', list: '<a>, <b>' });
    expect(renderParams(undefined, englishText)).toBeUndefined();
  });

  it('gives an error written for the screen its English, filled in, as its message', () => {
    const error = new MessageError(
      msg('add.quotaExceeded', '{max, plural, one {# question} other {# questions}}', { max: 20 }),
    );
    expect(error.message).toBe('20 questions');
    expect(error.name).toBe('MessageError');
    expect(error).toBeInstanceOf(Error);
  });

  it('shows an error’s own message only when one was written for the screen', () => {
    const fallback = msg('auth.failed', 'Something went wrong.');
    const written = msg('auth.created', 'Account created!');
    expect(messageOf(new MessageError(written), fallback)).toBe(written);
    expect(messageOf(new Error('Failed to fetch'), fallback)).toBe(fallback);
    expect(messageOf('a string', fallback)).toBe(fallback);
  });

  /** Two calls to `msg` are two objects; whether they say the same thing is a value question. */
  it('compares messages by key and params, not by identity', () => {
    const a = msg('profile.saidLevelUp', 'Level {level}.', { level: 3 });
    expect(sameMessage(a, msg('profile.saidLevelUp', 'Level {level}.', { level: 3 }))).toBe(true);
    expect(sameMessage(a, msg('profile.saidLevelUp', 'Level {level}.', { level: 4 }))).toBe(false);
    expect(sameMessage(a, msg('profile.saidReady', 'Ready.'))).toBe(false);
    expect(
      sameMessage(msg('profile.saidReady', 'Ready.'), msg('profile.saidReady', 'Ready.')),
    ).toBe(true);
    expect(sameMessage(null, null)).toBe(true);
    expect(sameMessage(a, null)).toBe(false);
    expect(
      sameMessage(
        msg('profile.saidLevelUp', 'x', { level: 3 }),
        msg('profile.saidLevelUp', 'x', { level: 3, extra: 1 }),
      ),
    ).toBe(false);
  });
});
