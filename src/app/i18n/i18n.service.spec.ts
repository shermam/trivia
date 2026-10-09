import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';
import { msg } from './message';

/**
 * `I18nService` (`docs/app.md` §1.16). English is never looked up — it rides
 * along with every call — so the cases worth pinning are the ones where a
 * translation is in use: what it changes, and what happens where it is silent.
 */
describe('I18nService', () => {
  let i18n: I18nService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    i18n = TestBed.inject(I18nService);
  });

  afterEach(() => {
    i18n.useTranslation('en', null);
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('renders the English at the call site when no translation is in use', () => {
    expect(i18n.locale()).toBe('en');
    expect(i18n.t('auth.signIn', 'Sign in')).toBe('Sign in');
    expect(i18n.t('author.backTo', 'Back to {label}', { label: 'Pending' })).toBe(
      'Back to Pending',
    );
    expect(
      i18n.t(msg('quiz.questions', '{n, plural, one {# question} other {# questions}}', { n: 1 })),
    ).toBe('1 question');
  });

  it('renders a translation’s text for a key it holds, in its own locale', () => {
    i18n.useTranslation('pt-BR', {
      'auth.signIn': 'Entrar',
      'quiz.questions': '{n, plural, one {# pergunta} other {# perguntas}}',
    });

    expect(i18n.locale()).toBe('pt-BR');
    expect(i18n.t('auth.signIn', 'Sign in')).toBe('Entrar');
    // pt-BR's `one` includes 0, and # is grouped the Brazilian way.
    expect(
      i18n.t('quiz.questions', '{n, plural, one {# question} other {# questions}}', { n: 0 }),
    ).toBe('0 pergunta');
    expect(
      i18n.t('quiz.questions', '{n, plural, one {# question} other {# questions}}', { n: 1234 }),
    ).toBe('1.234 perguntas');
  });

  /**
   * **Per key, never per bundle.** A translation that lacks one key still
   * renders everything it has; the missing one is English — formatted as
   * English — with a warning once in development, never an error.
   */
  it('falls back to English for a key the translation lacks, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    i18n.useTranslation('pt-BR', { 'auth.signIn': 'Entrar' });

    expect(i18n.t('auth.signIn', 'Sign in')).toBe('Entrar');
    expect(
      i18n.t('quiz.questions', '{n, plural, one {# question} other {# questions}}', { n: 1234 }),
    ).toBe('1,234 questions');
    i18n.t('quiz.questions', '{n, plural, one {# question} other {# questions}}', { n: 2 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('quiz.questions');
    expect(warn.mock.calls[0][0]).toContain('pt-BR');
  });

  it('renders a message inside a message in the same language, and a list of them joined', () => {
    i18n.useTranslation('es', {
      'form.attnMany': '{count} campos necesitan tu atención: {fields}.',
      'form.nameQuestion': 'pregunta',
      'form.nameSourceUrl': 'enlace de la fuente',
    });

    const summary = msg('form.attnMany', '{count} fields need your attention: {fields}.', {
      count: 2,
      fields: [msg('form.nameQuestion', 'question'), msg('form.nameSourceUrl', 'source link')],
    });
    expect(i18n.t(summary)).toBe('2 campos necesitan tu atención: pregunta, enlace de la fuente.');
  });

  it('sets <html lang> with the translation, and back to en without one', () => {
    i18n.useTranslation('es', { 'auth.signIn': 'Iniciar sesión' });
    expect(document.documentElement.lang).toBe('es');

    i18n.useTranslation('en', null);
    expect(document.documentElement.lang).toBe('en');
    expect(i18n.locale()).toBe('en');
    expect(i18n.t('auth.signIn', 'Sign in')).toBe('Sign in');
  });

  it('hands the unformatted text and its locale to a caller that splits it first', () => {
    const message = msg('auth.signIn', 'Sign in');
    expect(i18n.template(message)).toEqual(['Sign in', 'en']);

    i18n.useTranslation('pt-BR', { 'auth.signIn': 'Entrar' });
    expect(i18n.template(message)).toEqual(['Entrar', 'pt-BR']);
  });
});
