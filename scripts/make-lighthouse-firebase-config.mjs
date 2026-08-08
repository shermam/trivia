import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Derives the Hosting config the Lighthouse run serves through, by taking the
 * real `firebase.json` and widening exactly one CSP directive.
 *
 * The Lighthouse job is in an awkward position that no other check is in: it
 * builds with the `lighthouse` Angular configuration, which swaps in
 * `environment.e2e.ts` and therefore points Auth and Firestore at emulators on
 * `127.0.0.1:9099` / `:8080` — but it serves that build through the *real*
 * `firebase.json`, whose `connect-src` names the production Google origins and
 * nothing else. Those emulator ports are separate origins from the page's own
 * `127.0.0.1:5000`, so `'self'` does not cover them and every request Firebase
 * makes is refused. That is what turned this check red: not a bad policy, but a
 * policy correct for production being applied to a harness that isn't.
 *
 * The three ways out were all worse. Adding the emulator origins to the real
 * policy ships a production CSP that lets injected script reach services on a
 * visitor's own machine. Dropping the auth emulator from the run removes the
 * thing §4.4 says this check exists to exercise. Lowering the threshold is
 * forbidden outright (`CLAUDE.md` §3).
 *
 * So the harness gets a derived config rather than a second hand-written one:
 * there is no copy to drift, the production policy stays authoritative, and the
 * only difference is stated here in one place. Everything else about the CSP —
 * `script-src`, `style-src`, `frame-ancestors` — is exercised exactly as
 * production has it, which is what caught the logo's inline `style` attribute.
 */

const EMULATOR_ORIGINS = ['http://127.0.0.1:9099', 'http://127.0.0.1:8080'];
const SOURCE = 'firebase.json';
const TARGET = 'firebase.lighthouse.json';

const config = JSON.parse(readFileSync(SOURCE, 'utf8'));

const headers = config.hosting.headers.find((rule) => rule.source === '**')?.headers;
const csp = headers?.find((header) => header.key === 'Content-Security-Policy');
if (!csp) {
  throw new Error(`No Content-Security-Policy on the '**' rule in ${SOURCE} — has it been moved?`);
}

const directives = csp.value.split(';').map((directive) => directive.trim());
const index = directives.findIndex((directive) => directive.startsWith('connect-src '));
if (index === -1) {
  throw new Error(`No connect-src directive in the CSP — nothing to widen for the emulators.`);
}
directives[index] = `${directives[index]} ${EMULATOR_ORIGINS.join(' ')}`;
csp.value = directives.join('; ');

writeFileSync(TARGET, `${JSON.stringify(config, null, 2)}\n`);
console.log(`${TARGET}: connect-src widened with ${EMULATOR_ORIGINS.join(', ')}`);
