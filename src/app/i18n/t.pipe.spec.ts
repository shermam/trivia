import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';
import { msg, type Message } from './message';
import { TPipe } from './t.pipe';

@Component({
  imports: [TPipe],
  template: `
    <p data-cy="key">{{ 'auth.signIn' | t: 'Sign in' }}</p>
    <p data-cy="params">{{ 'author.backTo' | t: 'Back to {label}' : { label: label() } }}</p>
    <p data-cy="message">{{ status() | t }}</p>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly label = signal('Pending');
  readonly status = signal<Message | null>(null);
}

/**
 * The `t` pipe. Impure, and reading `I18nService`'s signal while the view
 * renders — so a change of translation re-renders an `OnPush` view that none
 * of whose inputs changed, which a pure pipe would never do.
 */
describe('TPipe', () => {
  afterEach(() => {
    TestBed.inject(I18nService).useTranslation('en', null);
    TestBed.resetTestingModule();
  });

  async function render() {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const text = (cy: string) =>
      (fixture.nativeElement as HTMLElement)
        .querySelector(`[data-cy="${cy}"]`)!
        .textContent!.trim();
    return { fixture, text };
  }

  it('renders a key with its English, a message, and nothing for no message', async () => {
    const { fixture, text } = await render();

    expect(text('key')).toBe('Sign in');
    expect(text('params')).toBe('Back to Pending');
    expect(text('message')).toBe('');

    fixture.componentInstance.status.set(msg('auth.created', 'Account created!'));
    await fixture.whenStable();
    expect(text('message')).toBe('Account created!');
  });

  it('re-renders an OnPush view when the translation changes, with no input changed', async () => {
    const { fixture, text } = await render();
    fixture.componentInstance.status.set(msg('auth.created', 'Account created!'));
    await fixture.whenStable();

    TestBed.inject(I18nService).useTranslation('pt-BR', {
      'auth.signIn': 'Entrar',
      'author.backTo': 'Voltar para {label}',
      'auth.created': 'Conta criada!',
    });
    await fixture.whenStable();

    expect(text('key')).toBe('Entrar');
    expect(text('params')).toBe('Voltar para Pending');
    expect(text('message')).toBe('Conta criada!');
  });
});
