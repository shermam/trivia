import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { pollUntil } from '../utils/poll-until.util';
import { AuthService } from './auth.service';
import {
  FirestoreRestClient,
  isFirestorePermissionDenied,
  type RestDocument,
} from './firestore-rest/firestore-rest.client';
import { GeoService } from './geo.service';

const CUSTOMERS_COLLECTION = 'customers';
const PRODUCTS_COLLECTION = 'products';
const CHECKOUT_TIMEOUT_MS = 20_000;

/**
 * How often to re-read a session document while waiting for the Cloud Function
 * to write its URL back, and for how long in total.
 *
 * This replaces an `onSnapshot` listener, because REST has no equivalent
 * (`FIRESTORE_SDK_VS_REST.md` §4). The trade is arithmetic: a checkout costs up
 * to 40 reads instead of about 2. That is irrelevant at any volume this app
 * will see — checkout is rare by definition, and a listener was never free
 * either, billing the initial read plus every change delivered for as long as
 * the tab stayed open.
 *
 * 500 ms rather than the 1 s the design document sketched, because this delay
 * is in front of a user who has just clicked Subscribe and is looking at a
 * spinner.
 */
const SESSION_POLL_INTERVAL_MS = 500;

/**
 * The wait after returning from Stripe, on `/pricing?checkout=success`.
 *
 * A full page load happens between paying and landing back here, so the
 * read-on-load below would normally be enough — except that the `stripeWebhook`
 * delivery which writes the subscription document races that redirect and
 * sometimes loses. A listener papered over this by definition. One second is
 * unhurried here: the user is reading a confirmation, not waiting on a click.
 */
const PRO_ACTIVATION_POLL_INTERVAL_MS = 1_000;
const PRO_ACTIVATION_TIMEOUT_MS = 20_000;

/**
 * `firestore.rules` caps how many session documents one account can create —
 * and therefore how many Cloud Function invocations and Stripe API calls it
 * can trigger — by constraining the document ID to `{window}-{slot}`, where
 * the window is derived from *server* time and `create` (unlike a general
 * write) only ever applies to an ID that doesn't exist yet. Rules cannot count
 * a user's documents, so the ID is the only place the cap can live; these two
 * constants have to match `sessionWindow`/`isRateLimitedSessionId` there.
 */
const SESSION_WINDOW_MS = 300_000;
const SESSION_SLOTS_PER_WINDOW = 10;

/** Subscription statuses our Cloud Functions backend considers "currently paying". */
const ACTIVE_SUBSCRIPTION_STATUSES = ['trialing', 'active'] as const;

/**
 * The role a subscription must carry to mean *Pro*, mirroring the server.
 *
 * A status alone is not entitlement. `stripeWebhook` derives the `stripeRole`
 * claim from `deriveClaimRole(status, priceRole)` (`functions/src/role.ts`),
 * which returns `null` when the price carries no `firebaseRole` metadata — so
 * an active subscription on an unlabelled price grants **nothing**, and
 * `firestore.rules` refuses every privileged write from that account. A UI
 * signal that looked only at `status` therefore unlocked a form the server was
 * always going to reject, with no way for the user to tell why. Same
 * correction as `getProPrices()` below, which already selects by role
 * "matching the server" — this half was simply missed.
 */
const PRO_ROLE = 'pro';

/**
 * The currency a visitor in this country has to be offered, when the catalog
 * carries a price in it.
 *
 * **Not a preference — a requirement.** This Stripe account is registered in
 * Brazil, and a Brazilian-issued card can only be charged in BRL; presented a
 * USD price it is declined with "your card doesn't support this currency".
 * Stripe's Adaptive Pricing does not rescue that case, because it localises
 * prices only for buyers **outside** the merchant's own country
 * (`functions/src/checkout-sessions.ts`). So a Brazilian buyer needs a real
 * BRL price, and this is what puts them on it by default.
 *
 * The country comes from `GeoService` — the app's own server first, the
 * browser's time zone second — and is a UI signal and nothing more
 * (`CLAUDE.md` §4.2): it decides which of the catalog's prices is preselected,
 * and the visitor can switch. What is actually charged is decided by the price
 * ID the session document carries, which the Cloud Function validates against
 * the mirrored catalog either way.
 *
 * **The input is a country and not a locale**, which is the whole reason
 * `GeoService` exists: a Brazilian reading English browses in `en-US`, so a
 * rule keyed on language quotes them dollars and their card is declined.
 * Language says what somebody reads; it says nothing about where their bank
 * is.
 */
const COUNTRY_CURRENCIES: Record<string, string> = { BR: 'brl' };

/**
 * Preferred when the visitor's own country asks for nothing in particular.
 * The catalog decides what exists; this only decides which of several it opens
 * on.
 */
const FALLBACK_CURRENCY = 'usd';

/**
 * Ceilings on the price lookup, so neither of its queries is unbounded
 * (`CLAUDE.md` §4.1 — every read needs a `where` *and* a `limit`).
 *
 * `MAX_PRO_PRODUCTS` matches the server's own cap in
 * `functions/src/products.ts`, because both are asking the same question of the
 * same collection and disagreeing about the answer's size would be a bug
 * neither side could see. There is one Pro product today; the cap only exists
 * so a Dashboard mistake can't turn this into an unbounded read.
 */
const MAX_PRO_PRODUCTS = 5;
const MAX_PRICES_PER_PRODUCT = 20;

/**
 * What a reader is told when the catalog carries no Pro price at all.
 *
 * Says that Pro is not on sale rather than inviting a retry, because nothing
 * the user does can change the answer: the catalog is written only by
 * `stripeWebhook`, and this is what an environment looks like before its
 * Stripe webhook has delivered a single `product.*`/`price.*` event
 * (`dev-environment.md` §3.1 steps 8–9).
 *
 * One constant because two call sites need it — the lookup that finds nothing
 * to sell, and the checkout that finds nothing to buy — and the second must
 * not be phrased as "please try again" for a cause that will not change.
 */
const NO_PRO_PRICE_MESSAGE =
  "Pro isn't available to buy right now — no active monthly Pro price is set up. Please try again later.";

/**
 * A ceiling the `onSnapshot` version never had. The query was filtered by
 * status but not bounded, which §4.1 asks for on every read — a listener on an
 * unbounded query re-reads the whole result set on every reconnect. One
 * customer holds one or two subscription documents; twenty is a cap that only
 * a bug could reach.
 */
const MAX_SUBSCRIPTIONS_PER_CUSTOMER = 20;

/** What the Cloud Function eventually writes back onto a session document. */
interface SessionOutcome {
  url?: string;
  error?: string;
}

/**
 * One currency the Pro tier is on sale in — a single mirrored Stripe Price.
 *
 * There is one of these per currency rather than one price with several
 * currencies on it. Stripe can carry alternative `currency_options` on a
 * price, but only until that price has been used: once a customer has checked
 * out against it the price is frozen, and selling in a new currency then means
 * a new Price object on the same Product. This app therefore models the
 * catalog the way that constraint forces — the Pro product carries one active
 * monthly price per currency, each with its own `firebaseRole: pro` metadata
 * (`docs/data-model.md`), and choosing a currency is choosing which price ID
 * checkout is started with.
 */
export interface ProPriceOption {
  /** The Stripe Price ID the checkout session document carries. */
  readonly priceId: string;
  /** Lowercase ISO 4217, exactly as Stripe stores it (`usd`, `brl`). */
  readonly currency: string;
  /** The smallest unit of that currency — 99 for $0.99 — or `null` if unset. */
  readonly unitAmount: number | null;
}

/**
 * Which currency to open on, given what the catalog offers and where the
 * reader appears to be.
 *
 * Pure and exported so the rule is testable without a Firestore fake: the
 * Brazilian case is the entire point of this feature and it must not depend on
 * the machine running the suite.
 *
 * **The country only decides anything when the catalog can honour it.** A
 * mapping to a currency nothing is priced in would leave the Subscribe button
 * quoting a price that does not exist, so an unmatched country falls through
 * to the same default as an unknown one — which is also what `null` means
 * here, and there are three ways to get it: the server was not asked, could
 * not tell, or the reader is simply somewhere the app prices normally.
 */
export function defaultProCurrency(
  options: readonly ProPriceOption[],
  country: string | null,
): string | null {
  const offered = new Set(options.map((option) => option.currency));
  const required = country ? COUNTRY_CURRENCIES[country.toUpperCase()] : undefined;
  if (required && offered.has(required)) {
    return required;
  }
  if (offered.has(FALLBACK_CURRENCY)) {
    return FALLBACK_CURRENCY;
  }
  // Catalog order, so which currency wins never depends on network timing.
  return options[0]?.currency ?? null;
}

/**
 * The mirrored price document as a currency the page can quote.
 *
 * `currency` is typed as `string` here but arrives from a Firestore document,
 * so it is checked rather than asserted — a price with no currency is not a
 * price anything can be quoted in, and `firstPerCurrency` drops it. Same for a
 * `unit_amount` that is not a number: Stripe leaves it `null` on a price whose
 * amount is decided at checkout, which this app does not sell, and the page
 * shows a placeholder rather than inventing a figure.
 */
function toProPriceOption(price: RestDocument): ProPriceOption {
  const currency = price.data['currency'];
  const unitAmount = price.data['unit_amount'];
  return {
    priceId: price.id,
    currency: typeof currency === 'string' ? currency.toLowerCase() : '',
    unitAmount: typeof unitAmount === 'number' ? unitAmount : null,
  };
}

/** One price per currency, keeping the first in catalog order and dropping the unusable. */
function firstPerCurrency(options: readonly ProPriceOption[]): ProPriceOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (option.currency === '' || seen.has(option.currency)) {
      return false;
    }
    seen.add(option.currency);
    return true;
  });
}

/**
 * A failure this service can explain, with a message written for the person
 * at the screen.
 *
 * Every rejection of `startProCheckout()`/`openBillingPortal()` is one of two
 * kinds, and the type is how a component tells them apart. This one carries a
 * verified cause — the caller is signed out, no Pro price is on sale, the
 * volume cap in `firestore.rules` is spent, the Cloud Function wrote an error
 * back (its own client-facing message; see `clientMessageFor` in
 * `functions/src/checkout-request.ts`), or the handshake reached its deadline
 * with nothing written — and its message is the thing to show. Anything else
 * that escapes is a transport failure (`FirestoreRestError`: a dropped
 * connection, a refused read, a 500) whose cause nobody verified, so a
 * component keeps its generic message for it (`subscriptionFailureMessage`).
 *
 * The distinction matters most to whoever is standing up a new environment:
 * an empty catalog and a function that never ran both end in a red line under
 * the Subscribe button, and "please try again" is the wrong instruction for
 * either. Naming the cause is what makes the difference visible from the
 * screen instead of from the function logs.
 */
export class SubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

/**
 * What a component shows for a rejected `startProCheckout()` or
 * `openBillingPortal()`: the `SubscriptionError`'s own message, or `fallback`
 * for a failure this service could not explain.
 *
 * The client half of `clientMessageFor` (`functions/src/checkout-request.ts`),
 * applying the same rule from the other side: distinguish the cases or stay
 * generic (`CLAUDE.md` §4.4). An unexplained error is logged rather than
 * dropped — once the screen says "please try again", the console is the only
 * place its real cause survives.
 */
export function subscriptionFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof SubscriptionError) {
    return error.message;
  }
  console.error('[subscription] unexplained failure', error);
  return fallback;
}

/**
 * Bridges the client to our own Cloud Functions backend (`functions/`,
 * `createCheckoutSession` + `stripeWebhook`) purely through the Firestore
 * collections that backend manages (`customers/{uid}/checkout_sessions`,
 * `customers/{uid}/subscriptions`, `products/{id}/prices`). This used to be
 * the officially maintained "Run Subscriptions with Stripe" Firebase
 * Extension, but that entire product line is shutting down in March 2027 —
 * we now own equivalent functions directly instead, using the same
 * Firestore schema so this service (and firestore.rules) didn't need to
 * change shape, only where the data comes from.
 *
 * `isProUser` here is an *optimistic* signal — the subscription document
 * appears within moments of a successful checkout, well before the next
 * natural ID-token refresh. It's meant for UI only: the actual security gate
 * for privileged writes is the `stripeRole` custom claim enforced in
 * firestore.rules (`AuthService.isProUser`), which this service explicitly
 * nudges to refresh the moment it first sees an active subscription — see
 * `refreshIdToken()` in AuthService.
 *
 * **It used to be real-time and no longer is** (`BACKLOG.md` item 2). Two
 * `onSnapshot` listeners were the last thing holding the 558.98 kB Firestore
 * SDK in the bundle, and REST has no equivalent, so both became reads:
 * subscription status is read when the signed-in user changes and again after
 * returning from checkout, and the checkout handshake polls. What is lost is
 * a second tab updating without a reload, for a tier whose only entitlement is
 * an "Add a question" link. What is gained is the largest thing this app
 * shipped.
 */
@Injectable({ providedIn: 'root' })
export class SubscriptionService {
  private readonly authService = inject(AuthService);
  private readonly rest = inject(FirestoreRestClient);
  private readonly geoService = inject(GeoService);

  private readonly hasActiveSubscriptionDocSignal = signal(false);
  private trackedUid: string | null = null;
  private proPricesPromise: Promise<readonly ProPriceOption[]> | null = null;

  private readonly proPriceOptionsSignal = signal<readonly ProPriceOption[]>([]);
  private readonly selectedCurrencySignal = signal<string | null>(null);

  /**
   * Whether the currency on screen was chosen by the reader rather than
   * guessed for them.
   *
   * The two signals this feature runs on arrive at different times — the
   * catalog, then the server's answer about where the visitor is, up to two
   * seconds later — and the reader can click in between. A default that landed
   * after that click would silently undo it, on the one control whose whole
   * purpose is to let them override the guess. So a manual choice is recorded
   * and every later default defers to it.
   *
   * It is cleared when the chosen currency stops being on sale, because at
   * that point there is no choice left to respect.
   */
  private currencyChosenByReader = false;

  /**
   * Every currency the Pro tier is on sale in, in catalog order. Empty until
   * `loadProPrices()` has resolved — and empty is what a page with nothing to
   * render yet should see, not a guess at a price (`CLAUDE.md` §4.4).
   */
  readonly proPriceOptions = this.proPriceOptionsSignal.asReadonly();

  /** The currency the reader is being quoted, or `null` before the catalog lands. */
  readonly selectedCurrency = this.selectedCurrencySignal.asReadonly();

  /**
   * The price that will actually be bought: the selected currency's, falling
   * back to the first the catalog offers so a selection that no longer exists
   * (a currency withdrawn in the Dashboard between load and click) cannot
   * leave the button quoting nothing.
   */
  readonly selectedProPrice = computed<ProPriceOption | null>(() => {
    const options = this.proPriceOptionsSignal();
    const currency = this.selectedCurrencySignal();
    return options.find((option) => option.currency === currency) ?? options[0] ?? null;
  });

  /**
   * Orders concurrent reads of the same subcollection.
   *
   * `onSnapshot` delivered one stream in commit order, so this could not
   * arise. Reads can: on `/pricing?checkout=success` the constructor effect's
   * read and `awaitProActivation`'s poll are both in flight against the same
   * documents, and without a sequence the answer that lands last wins even
   * when it is the older question. The visible symptom would be Pro flickering
   * back off on the very page confirming the payment. Each read takes a ticket
   * before it starts; `applyProState` refuses one older than what it has
   * already applied.
   */
  private readSequence = 0;
  private appliedSequence = 0;

  readonly isProUser = computed(
    () => this.authService.isProUser() || this.hasActiveSubscriptionDocSignal(),
  );

  constructor() {
    effect(() => {
      const user = this.authService.user();
      this.trackUser(user && !user.isAnonymous ? user.uid : null);
    });
  }

  private trackUser(uid: string | null): void {
    if (uid === this.trackedUid) {
      return;
    }
    this.trackedUid = uid;
    this.hasActiveSubscriptionDocSignal.set(false);

    if (uid) {
      void this.refreshSubscriptionState(uid);
    }
  }

  /**
   * Re-reads whether this user currently has an active Pro subscription.
   *
   * Swallows its own failures deliberately. A read that fails leaves the
   * optimistic signal `false`, and the consequence of that is small precisely
   * because the signal is not the gate: `isProUser` is `claim || document`, so
   * a subscriber whose ID token already carries `stripeRole` still reads as Pro
   * with this half unavailable. The listener this replaces retried internally;
   * nothing here does, which is the honest cost of owning the transport.
   */
  private async refreshSubscriptionState(uid: string): Promise<void> {
    const sequence = ++this.readSequence;
    try {
      this.applyProState(uid, await this.readHasActiveProSubscription(uid), sequence);
    } catch {
      // See above — the claim is the authority, this is only the fast path.
    }
  }

  private async readHasActiveProSubscription(uid: string): Promise<boolean> {
    const documents = await this.rest.runQuery(
      {
        collectionPath: `${CUSTOMERS_COLLECTION}/${uid}/subscriptions`,
        where: [{ field: 'status', op: 'IN', value: [...ACTIVE_SUBSCRIPTION_STATUSES] }],
        limit: MAX_SUBSCRIPTIONS_PER_CUSTOMER,
      },
      { timeoutMs: CHECKOUT_TIMEOUT_MS },
    );
    // `role` is filtered here rather than in the query on purpose:
    // `where('status','in',…)` plus `where('role','==',…)` needs a composite
    // index, and index configuration is the one thing the emulator cannot
    // verify (finding D3 took the deploy pipeline down for four merges). This
    // subcollection holds a handful of documents for one user and is already
    // bounded by the status filter and the limit above, so the check costs
    // nothing to do in memory.
    return documents.some((document) => document.data['role'] === PRO_ROLE);
  }

  private applyProState(uid: string, isActive: boolean, sequence: number): void {
    // Two axes of staleness, and both have to be checked: the signed-in user
    // may have changed while the read was in flight, and an older read may be
    // landing after a newer one has already answered.
    if (this.trackedUid !== uid || sequence < this.appliedSequence) {
      return;
    }
    this.appliedSequence = sequence;
    const justActivated = isActive && !this.hasActiveSubscriptionDocSignal();
    this.hasActiveSubscriptionDocSignal.set(isActive);
    if (justActivated) {
      void this.authService.refreshIdToken();
    }
  }

  /**
   * Waits for a just-completed checkout to show up as Pro, called by
   * `PricingComponent` when Stripe redirects back to `?checkout=success`.
   *
   * Resolves as soon as the subscription document lands, or gives up quietly
   * at the deadline — in which case the user is a reload away from correct,
   * and `stripeRole` on their next token refresh gets there on its own.
   */
  async awaitProActivation(): Promise<void> {
    await pollUntil(
      async () => {
        const uid = this.trackedUid;
        // Auth persistence may still be restoring the session this page load —
        // "no user yet" is a not-yet, not an answer.
        if (!uid) {
          return null;
        }
        const sequence = ++this.readSequence;
        try {
          if (!(await this.readHasActiveProSubscription(uid))) {
            return null;
          }
        } catch {
          // A failed read here is also a not-yet: this is polling for a webhook
          // that has not landed, on a page the user will sit on for a few
          // seconds either way.
          return null;
        }
        this.applyProState(uid, true, sequence);
        return true;
      },
      { intervalMs: PRO_ACTIVATION_POLL_INTERVAL_MS, timeoutMs: PRO_ACTIVATION_TIMEOUT_MS },
    );
  }

  /**
   * Reads the catalog and publishes what Pro costs, for the page to render.
   *
   * **The read moved onto page load, and that is a real cost worth stating.**
   * It used to happen on the Subscribe click alone, so an anonymous visitor
   * browsing `/pricing` cost nothing; now a page load that reaches `/pricing`
   * spends roughly two public reads (the products query, plus one prices query
   * per active Pro product). That is the price of the page showing a real
   * amount instead of a number written into the template — which it has to,
   * because the amount now depends on which currency the reader is being
   * quoted, and a literal would be wrong for half of them. Everything after
   * the first read is free: the promise is memoised for the service's
   * lifetime, so `startProCheckout()` reuses it and so does a second visit to
   * `/pricing` in the same page load, which re-runs this method and re-reads
   * nothing.
   *
   * **Failures are swallowed**, and the page shows a placeholder rather than a
   * price. A catalog that cannot be read is not something the reader can act
   * on at page load, and guessing an amount would be the alarming answer to a
   * question nobody asked (`CLAUDE.md` §4.4). The cause is still reported the
   * moment it matters — clicking Subscribe re-runs the same lookup and shows
   * the `SubscriptionError` it throws.
   *
   * **The country lookup is started first and awaited last**, so the two round
   * trips overlap instead of queueing. The catalog decides when the card can
   * render at all, so it is what the page waits on; the country only decides
   * which radio is checked, and arriving late costs nothing more than moving
   * it. Where the server answers before the catalog does — the common case,
   * since it is one small response against two Firestore queries — both
   * selections are computed from the same answer and the reader never sees an
   * intermediate one.
   */
  async loadProPrices(): Promise<void> {
    // Started before the await below, not inside it: this is the whole reason
    // the two waits cost one wait.
    const country = this.geoService.resolveCountry();

    let options: readonly ProPriceOption[];
    try {
      options = await this.getProPrices();
    } catch {
      return;
    }
    this.proPriceOptionsSignal.set(options);
    // A currency is chosen from what is known *now* — the browser's time zone,
    // which needs no request — rather than holding the radiogroup unchecked
    // until the server answers. A control with nothing checked for up to two
    // seconds is worse than one that moves once, and on a Brazilian machine
    // this is already the right answer, so it does not move at all.
    this.applyDefaultCurrency(options, this.geoService.timeZoneCountry());
    this.applyDefaultCurrency(options, await country);
  }

  /**
   * Puts the selection back in step with the catalog and the best country
   * signal so far — unless the reader has already answered the question
   * themselves.
   *
   * The postcondition is that the selection is a currency the catalog
   * **offers**, not merely that a selection exists. Keeping a currency the
   * catalog has stopped carrying would leave the radiogroup with nothing
   * checked (each radio asks whether it *is* the selection) while
   * `selectedProPrice` quietly fell back to the first price, so the page would
   * quote an amount no radio claimed.
   */
  private applyDefaultCurrency(options: readonly ProPriceOption[], country: string | null): void {
    const stillOffered = options.some(
      (option) => option.currency === this.selectedCurrencySignal(),
    );
    if (stillOffered && this.currencyChosenByReader) {
      return;
    }
    // A choice whose currency has left the catalog is not a choice any more,
    // so the next default is free to overwrite it.
    this.currencyChosenByReader = false;
    this.selectedCurrencySignal.set(defaultProCurrency(options, country));
  }

  /**
   * Quotes the reader in another of the currencies the catalog offers.
   *
   * A currency the catalog does not carry is ignored rather than stored: the
   * selection decides which price ID checkout is started with, and a selection
   * with no price behind it would turn the Subscribe button into a button that
   * cannot work. It is also not recorded as a choice — the reader has not
   * successfully chosen anything, and pretending otherwise would freeze the
   * default they never saw.
   */
  selectCurrency(currency: string): void {
    if (this.proPriceOptionsSignal().some((option) => option.currency === currency)) {
      this.selectedCurrencySignal.set(currency);
      this.currencyChosenByReader = true;
    }
  }

  /**
   * Resolves every currency the "Pro" tier is on sale in, by reading the
   * `products`/`prices` collections the webhook handler
   * (`functions/src/products.ts`) keeps synced from the Stripe Dashboard — so
   * no price is ever hardcoded here, and adding a currency in Stripe needs no
   * frontend deploy.
   *
   * **Selects by `role`, matching the server.** `createCheckoutSession` accepts
   * a price only if it belongs to an active product carrying `role: 'pro'`
   * (`functions/src/checkout-request.ts`), so picking by "first active product
   * with a monthly price" — as this used to — is a different question with the
   * same answer only while exactly one product exists. The day a second one is
   * added, the client would send a price the server is bound to reject, and the
   * failure would surface as checkout simply not working.
   *
   * **Both queries are bounded and the per-product ones run in parallel.**
   * Neither carried a `limit` before, and the price lookups ran one after
   * another (finding C5).
   */
  /**
   * The Price ID checkout should use: the currency the reader was quoted.
   *
   * Re-resolved from the catalog rather than read off `selectedProPrice`, so a
   * click that arrives before the page's own load has finished — or after a
   * failed load — still gets a price rather than a refusal. Which currency it
   * lands on is then the same rule the page applies: the selection if one was
   * made and still exists, otherwise the catalog's first.
   */
  private async selectedProPriceId(): Promise<string> {
    const options = await this.getProPrices();
    const currency = this.selectedCurrencySignal();
    // `at(0)` rather than `[0]`, because the index signature lies: it types an
    // empty list's first element as a `ProPriceOption` and the guard below as
    // dead code. Nothing can reach it while `loadProPriceOptions()` refuses to
    // return an empty list — which is the reason to write it out rather than
    // rely on it. A refusal held at a distance, in another method, fails here
    // as a `TypeError` on `undefined`, and the reader is shown "Cannot read
    // properties of undefined" in place of the sentence that explains it.
    const chosen = options.find((option) => option.currency === currency) ?? options.at(0);
    if (!chosen) {
      throw new SubscriptionError(NO_PRO_PRICE_MESSAGE);
    }
    return chosen.priceId;
  }

  private getProPrices(): Promise<readonly ProPriceOption[]> {
    if (!this.proPricesPromise) {
      this.proPricesPromise = this.loadProPriceOptions();
      // Don't cache a failed lookup: a product fixed in the Dashboard after
      // a failed attempt should be picked up on the very next click, not
      // require a full page reload.
      this.proPricesPromise.catch(() => {
        this.proPricesPromise = null;
      });
    }
    return this.proPricesPromise;
  }

  private async loadProPriceOptions(): Promise<readonly ProPriceOption[]> {
    // Filters on `role` alone, exactly as the server's own catalog check does
    // (`functions/src/products.ts`): one equality filter is served by the
    // automatic single-field index, while `role` + `active` together would
    // need a composite one. `active` is checked below instead, which costs
    // nothing extra since the document is already here.
    const products = await this.rest.runQuery(
      {
        collectionPath: PRODUCTS_COLLECTION,
        where: [{ field: 'role', op: 'EQUAL', value: PRO_ROLE }],
        limit: MAX_PRO_PRODUCTS,
      },
      { timeoutMs: CHECKOUT_TIMEOUT_MS },
    );

    const activeProducts = products.filter((product) => product.data['active'] === true);

    // Every product's prices are fetched at once. This used to be a sequential
    // `for` loop that awaited each subcollection in turn (finding C5), so the
    // wait was the sum of the round trips rather than the slowest one — and it
    // ran on the click that starts checkout, where the delay is most visible.
    const monthlyPrices = await Promise.all(
      activeProducts.map(async (product) => {
        const prices = await this.rest.runQuery(
          {
            collectionPath: `${PRODUCTS_COLLECTION}/${product.id}/prices`,
            where: [{ field: 'active', op: 'EQUAL', value: true }],
            limit: MAX_PRICES_PER_PRODUCT,
          },
          { timeoutMs: CHECKOUT_TIMEOUT_MS },
        );
        return prices.filter((price) => price.data['interval'] === 'month').map(toProPriceOption);
      }),
    );

    // Catalog order, not order of arrival — parallelism must not make which
    // price is chosen depend on network timing. One price per currency: two
    // monthly BRL prices on the same product is a Dashboard mistake, and
    // picking the first is both deterministic and the older of the two.
    const options = firstPerCurrency(monthlyPrices.flat());
    if (options.length === 0) {
      throw new SubscriptionError(NO_PRO_PRICE_MESSAGE);
    }
    return options;
  }

  /**
   * Creates a Stripe Checkout session doc, waits for `createCheckoutSession`
   * (functions/src/checkout-sessions.ts) to write back a hosted checkout
   * URL, and redirects the browser to it. Requires a
   * fully signed-in (non-anonymous) caller — also enforced by
   * firestore.rules, but checked here first so an anonymous caller never
   * even creates a doc that would just be rejected.
   *
   * The payload is deliberately only `price` and `origin`. The redirect URLs
   * and the checkout mode used to be sent from here and handed to Stripe
   * verbatim; the function decides both itself now, so there is nothing left
   * on this path for a hand-written document to redirect or re-price.
   *
   * **The currency is the price ID and nothing else.** Each currency is its own
   * Stripe Price on the Pro product, so choosing one is choosing which of them
   * to check out against — there is no second field to validate, and the
   * function's existing catalog check (`isPriceSellableAsPro`) covers the
   * choice exactly as it covers any other price ID a client can send.
   */
  async startProCheckout(): Promise<void> {
    const checkoutUrl = await this.runSessionHandshake({
      collectionName: 'checkout_sessions',
      // A factory, not a value, so the catalog is only consulted once the
      // caller has been confirmed signed in — an anonymous *click* should cost
      // a read no more than it should cost a rejected write. (Rendering the
      // page costs one either way now; the lookup is memoised, so this reuses
      // it rather than repeating it.)
      buildPayload: async () => ({
        price: await this.selectedProPriceId(),
        origin: window.location.origin,
      }),
      signedOutMessage: 'Sign in before subscribing.',
      timeoutMessage: 'Timed out waiting for Stripe checkout to start. Please try again.',
      failureMessage: 'Stripe checkout could not be started. Please try again.',
    });
    window.location.assign(checkoutUrl);
  }

  /**
   * Creates a Stripe billing portal session doc, waits for
   * `createPortalSession` (functions/src/billing-portal.ts) to write back a
   * hosted portal URL, and redirects the browser to it — lets a Pro
   * subscriber manage their payment method or cancel from Stripe's own UI.
   * Same doc-create-then-poll handshake as `startProCheckout` above.
   */
  async openBillingPortal(): Promise<void> {
    const portalUrl = await this.runSessionHandshake({
      collectionName: 'portal_sessions',
      buildPayload: () => ({ origin: window.location.origin }),
      signedOutMessage: 'Sign in before managing your subscription.',
      timeoutMessage: 'Timed out waiting for the billing portal to open. Please try again.',
      failureMessage: 'Billing portal could not be opened. Please try again.',
    });
    window.location.assign(portalUrl);
  }

  /**
   * The create-then-wait half both flows share: write a session document, wait
   * for the Cloud Function to write a `url` (or an `error`) back onto it, and
   * return that URL. Both sides of the handshake are identical for checkout
   * and the billing portal, so they share one implementation rather than two
   * that can drift.
   *
   * The deadline used to be the delicate part. With `onSnapshot` it had to live
   * *inside* the promise rather than racing it from outside, because giving up
   * had to also mean detaching the listener — racing left the subscription
   * attached for the rest of the session, still receiving writes and still
   * billed for them, for a checkout nobody was waiting on. Polling has nothing
   * to detach: when `pollUntil` returns, the last request has already
   * completed and no timer is armed. That whole class of bug is gone by
   * construction rather than by care.
   */
  private async runSessionHandshake(options: {
    collectionName: 'checkout_sessions' | 'portal_sessions';
    buildPayload: () => Record<string, string> | Promise<Record<string, string>>;
    signedOutMessage: string;
    timeoutMessage: string;
    failureMessage: string;
  }): Promise<string> {
    const user = this.authService.user();
    if (!user || user.isAnonymous) {
      throw new SubscriptionError(options.signedOutMessage);
    }

    const payload = await options.buildPayload();
    const sessionPath = await this.createSessionDoc(user.uid, options.collectionName, payload);

    // A read that fails is a not-yet, not a failure. The document is about to
    // be written and there is budget left to ask again, and `onSnapshot`
    // reconnected through a transient drop by itself — turning the payment
    // path into one-strike would be a regression the migration has no reason
    // to cause. The last error is kept rather than swallowed, so a deadline
    // reached while reads were failing reports *that* instead of narrating a
    // timeout it did not verify (`CLAUDE.md` §4.4); a read that succeeds
    // clears it, so only an unresolved failure is ever reported.
    let lastReadError: Error | null = null;
    const outcome = await pollUntil(
      async (remainingMs) => {
        try {
          const result = await this.readSessionOutcome(
            sessionPath,
            options.failureMessage,
            remainingMs,
          );
          lastReadError = null;
          return result;
        } catch (error) {
          lastReadError = error instanceof Error ? error : new Error(String(error));
          return null;
        }
      },
      { intervalMs: SESSION_POLL_INTERVAL_MS, timeoutMs: CHECKOUT_TIMEOUT_MS },
    );

    if (!outcome) {
      // A deadline reached while the reads were answering (the document was
      // there, with no URL yet) is a cause this code verified, so it is named.
      // A deadline reached on a failing read is not: that error is handed on
      // as the transport's own type, and the component stays generic for it.
      throw lastReadError ?? new SubscriptionError(options.timeoutMessage);
    }
    if (outcome.error) {
      // Written by the function for exactly this purpose (`clientMessageFor`).
      throw new SubscriptionError(outcome.error);
    }
    return outcome.url!;
  }

  /**
   * One look at a session document: the URL if it has arrived, the failure if
   * the function reported one, and `null` for "still working" — which is both
   * the document not existing yet and it existing with neither field set.
   */
  private async readSessionOutcome(
    sessionPath: string,
    failureMessage: string,
    remainingMs: number,
  ): Promise<SessionOutcome | null> {
    // The budget left, not the whole budget. Giving each read the full
    // `CHECKOUT_TIMEOUT_MS` composes two 20-second bounds into forty seconds of
    // wall clock, because an attempt that starts at 19.5s is still allowed its
    // own twenty — and the constant, the comments and the user-facing message
    // all say twenty.
    const document = await this.rest.getDocument(sessionPath, {
      timeoutMs: remainingMs,
    });
    const data = document?.data;
    if (!data) {
      return null;
    }
    const error = data['error'] as { message?: string } | undefined;
    if (error) {
      return { error: error.message ?? failureMessage };
    }
    return typeof data['url'] === 'string' ? { url: data['url'] } : null;
  }

  /**
   * Writes the session document at an ID the volume cap in `firestore.rules`
   * accepts: `{current 5-minute window}-{slot}`, and returns its path.
   *
   * Slots are tried from a random starting point, so two checkouts inside the
   * same window don't both collide on slot 0 — a rejected slot is one that has
   * already been used this window, which for a real user only happens if they
   * genuinely started checkout twice in five minutes. Running out of all ten
   * is the cap actually biting.
   *
   * The message deliberately doesn't name a cause. A refusal here has two
   * plausible ones — every slot used, or a client old enough to still be
   * sending the pre-validation payload — and picking one to narrate would be
   * wrong half the time. Reloading and retrying is the answer to both.
   */
  private async createSessionDoc(
    uid: string,
    collectionName: string,
    payload: Record<string, string>,
  ): Promise<string> {
    const currentWindow = Math.floor(Date.now() / SESSION_WINDOW_MS);
    const firstSlot = Math.floor(Math.random() * SESSION_SLOTS_PER_WINDOW);

    for (let attempt = 0; attempt < SESSION_SLOTS_PER_WINDOW; attempt++) {
      const slot = (firstSlot + attempt) % SESSION_SLOTS_PER_WINDOW;
      const sessionPath = `${CUSTOMERS_COLLECTION}/${uid}/${collectionName}/${currentWindow}-${slot}`;
      try {
        await this.rest.setDocument(sessionPath, payload, { timeoutMs: CHECKOUT_TIMEOUT_MS });
        return sessionPath;
      } catch (error) {
        if (!isFirestorePermissionDenied(error)) {
          throw error;
        }
      }
    }

    throw new SubscriptionError(
      'Too many attempts just now. Reload the page and try again in a few minutes.',
    );
  }
}
