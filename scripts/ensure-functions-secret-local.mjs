import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Materializes `functions/.secret.local` (gitignored) from its committed
 * `.example` template, so the Functions emulator never falls through to a
 * real Secret Manager fetch — without the file, the emulator tries exactly
 * that at the first invocation of any function declaring `secrets: [...]`,
 * and on a machine with a Google credential it silently succeeds, handing
 * the local emulator the real production Stripe key. The template's own
 * comment holds the full reasoning.
 *
 * Runs from the root `postinstall`, which every workflow and fresh checkout
 * already goes through. Never overwrites: a developer who has put real
 * test-mode keys in `.secret.local` (the supported way to run the emulator
 * against a real Stripe account) keeps them across installs.
 */

const template = fileURLToPath(new URL('../functions/.secret.local.example', import.meta.url));
const target = fileURLToPath(new URL('../functions/.secret.local', import.meta.url));

if (!existsSync(template)) {
  throw new Error(`${template} is missing — has the committed template been moved?`);
}

if (!existsSync(target)) {
  copyFileSync(template, target);
  console.log('functions/.secret.local: created from its committed .example template');
}
