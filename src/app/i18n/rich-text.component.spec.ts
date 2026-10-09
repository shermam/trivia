import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';
import { msg, type Message } from './message';
import { RichTextComponent } from './rich-text.component';

@Component({
  imports: [RichTextComponent],
  template: `
    <p data-cy="out"><app-rich-text [message]="message()" [tags]="{ terms: link, code }" /></p>
    <ng-template #link let-text
      ><a href="/terms">{{ text }}</a></ng-template
    >
    <ng-template #code let-text
      ><code>{{ text }}</code></ng-template
    >
  `,
})
class Host {
  readonly message = signal<Message>(
    msg('mine.removeNote', 'Read <terms>the Terms</terms> first.'),
  );
}

/**
 * Markup inside a sentence (`docs/app.md` §1.16): the tags are the message's
 * own names, mapped by the host to templates, so a translation can move the
 * link and nothing it says can become an element.
 */
describe('RichTextComponent', () => {
  afterEach(() => {
    TestBed.inject(I18nService).useTranslation('en', null);
    TestBed.resetTestingModule();
  });

  async function render(message?: Message) {
    const fixture = TestBed.createComponent(Host);
    if (message) fixture.componentInstance.message.set(message);
    await fixture.whenStable();
    const out = (fixture.nativeElement as HTMLElement).querySelector('[data-cy="out"]')!;
    return { fixture, out };
  }

  it('renders each tag through its template and the rest as text', async () => {
    const { out } = await render();

    expect(out.textContent!.trim()).toBe('Read the Terms first.');
    const link = out.querySelector('a')!;
    expect(link.textContent).toBe('the Terms');
    expect(link.getAttribute('href')).toBe('/terms');
  });

  it('lets a translation put the tag wherever its grammar wants it', async () => {
    const { fixture, out } = await render();

    TestBed.inject(I18nService).useTranslation('pt-BR', {
      'mine.removeNote': 'Leia primeiro <terms>os Termos</terms>.',
    });
    await fixture.whenStable();

    expect(out.textContent!.trim()).toBe('Leia primeiro os Termos.');
    expect(out.querySelector('a')!.textContent).toBe('os Termos');
  });

  it('fills placeholders after splitting, so a value with markup in it stays text', async () => {
    const { out } = await render(
      msg('form.markdownHelp', 'Type <code>{sample}</code> for {what}.', {
        sample: '<b>bold</b>',
        what: '<i>this</i>',
      }),
    );

    expect(out.querySelector('code')!.textContent).toBe('<b>bold</b>');
    expect(out.querySelector('b')).toBeNull();
    expect(out.querySelector('i')).toBeNull();
    expect(out.textContent!.trim()).toBe('Type <b>bold</b> for <i>this</i>.');
  });

  it('renders a tag the host did not map as its text, never as an element', async () => {
    const { out } = await render(msg('mine.removeNote', 'Read <script>this</script> now.'));

    expect(out.querySelector('script')).toBeNull();
    expect(out.textContent!.trim()).toBe('Read this now.');
  });
});
