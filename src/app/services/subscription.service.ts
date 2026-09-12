import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { pollUntil } from '../utils/poll-until.util';
import { AuthService } from './auth.service';
import {
  FirestoreRestClient,
  isFirestorePermissionDenied,
  type RestDocument,
} from './firestore-rest/firestore-rest.client';
import { GeoService } from './geo.service';
import { PricingCacheService, type ReadyCheckout } from './pricing-cache.service';

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

/**
 * How many of those ten slots a *pre-created* session may spend in one window.
 *
 * Pre-creation happens without anybody asking for it — on arriving at
 * `/pricing`, and again a second after each currency change — so left
 * unbounded it would let a reader idly flicking the currency switch exhaust
 * the cap and then be refused the checkout they finally wanted. Three leaves
 * seven slots for clicks that are real, which is more than a person can use;
 * and running out of pre-creations is invisible, because Subscribe simply
 * falls back to creating the session on the click, which is what it did before
 * any of this existed.
 *
 * **The count is per page load**, because it lives on this service and the
 * service dies with the document: a reload starts a fresh three. That is not a
 * hole, because the reload also *reuses* the stored session rather than making
 * another one — the real bound is the rules' ten per window, and this ration
 * only stops the switch-flicking case reaching it.
 */
const MAX_PRECREATED_SESSIONS_PER_WINDOW = 3;

/**
 * How long the browser is given to go idle before the background prime runs
 * for a signed-in reader who could actually buy something.
 *
 * `requestIdleCallback`'s own `timeout`, matching `initOfflinePrefetch` — a
 * tab that never goes idle should still warm the cache eventually, because the
 * whole point is that it happens before the reader opens `/pricing` rather
 * than while they wait.
 */
const IDLE_PRIME_TIMEOUT_MS = 10_000;

/** What a browser without `requestIdleCallback` (Safari < 17) waits instead. */
const IDLE_PRIME_FALLBACK_MS = 2_000;

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

/**
 * Whether two resolved catalogs say the same thing.
 *
 * Used to decide whether a background revalidation has anything to publish. A
 * signal set to a freshly-built array with identical contents is still a
 * change as far as Angular is concerned, and the visible consequence is not
 * nothing: re-publishing re-runs the default-currency rule, which would move a
 * radio the reader is looking at for no reason at all. Order is part of the
 * comparison because order is what decides the default when no country does.
 */
function sameProPriceOptions(a: readonly ProPriceOption[], b: readonly ProPriceOption[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (option, index) =>
        option.priceId === b[index].priceId &&
        option.currency === b[index].currency &&
        option.unitAmount === b[index].unitAmount,
    )
  );
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
  private readonly pricingCache = inject(PricingCacheService);

  private readonly hasActiveSubscriptionDocSignal = signal(false);
  private trackedUid: string | null = null;
  private proPricesPromise: Promise<readonly ProPriceOption[]> | null = null;

  /**
   * The handshake currently creating a Checkout Session, if one is running.
   *
   * A *single slot*, and at most one may be in flight at a time, because
   * `createCheckoutSession` expires the customer's open sessions before
   * creating another (`functions/src/checkout-sessions.ts`, which is what lets
   * a buyer change their mind about the currency at all). Two concurrent
   * invocations therefore race: whichever create lands second kills the
   * session the first one is about to hand back, and nothing on the client can
   * see that it happened.
   *
   * The session that is *ready* is deliberately **not** held here. It lives in
   * `localStorage` (`PricingCacheService`) and is re-read on every use, because
   * another tab can have replaced or cleared it since — see `readyCheckoutFor`.
   */
  private pendingCheckout: { uid: string; priceId: string; promise: Promise<string> } | null = null;

  /** Pre-creations spent so far in the current `firestore.rules` session window. */
  private precreateWindow = -1;
  private precreatesInWindow = 0;

  /**
   * Set once a ready entry could not be stored at all.
   *
   * Pre-creation is only worth a Stripe session and a slot of the volume cap
   * if the URL can be found again, and it is found through storage alone. A
   * browser that refuses to store it (a private window, a quota refusal) gains
   * nothing from further attempts, so this stops them and the click falls back
   * to creating its own session — which is what it did before any of this.
   */
  private readyCheckoutUnstorable = false;

  /** Whether the once-per-page-load idle prime has been scheduled. */
  private idlePrimeScheduled = false;

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
    const previous = this.trackedUid;
    this.trackedUid = uid;
    this.hasActiveSubscriptionDocSignal.set(false);

    // Only when an account this tab was *already* tracking is replaced — a
    // sign-out, or a different person signing in. The first call of a page
    // load moves from `null` to whoever was restored from persistence, and
    // clearing there would throw away the pre-created session on every reload,
    // which is precisely what the stored entry exists to survive.
    if (previous !== null) {
      this.pendingCheckout = null;
      this.forgetReadyCheckout();
    }

    if (uid) {
      // Chained rather than fired alongside, because whether this reader is
      // worth priming for is exactly what the read answers. `refreshSubscriptionState`
      // swallows its own failures, so this always runs.
      void this.refreshSubscriptionState(uid).then(() => this.primeOnIdle());
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
      // Whatever session was waiting is the one they just completed, or one
      // Stripe will refuse now that they are subscribed. Either way it is not
      // a thing to redirect anybody to.
      this.forgetReadyCheckout();
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
   * Publishes what Pro costs, for the page to render — from this browser's own
   * memory first, and from the catalog a moment later.
   *
   * **Cache first, then revalidate.** A visitor who has opened `/pricing`
   * before still has the resolved catalog and the country in `localStorage`
   * (`PricingCacheService`, 24 h), so the amount, the currency and the switch
   * are all on screen in the first frame rather than after a geo round trip
   * and two Firestore reads. The network answer is then fetched anyway and
   * published **only if it differs**, so the usual case — nothing has changed —
   * is a render the reader never sees. A price edited in the Stripe Dashboard
   * therefore reaches a returning visitor on their next visit, and a reader
   * sitting on the page when it is edited keeps seeing the old amount until
   * they reload; what they are *charged* is never stale, because the price ID
   * is validated against the live catalog by the Cloud Function.
   *
   * **The cost, stated plainly.** A page load that reaches `/pricing` still
   * spends roughly two public reads (the products query, plus one prices query
   * per active Pro product) — the cache makes them late rather than absent,
   * because an amount nobody revalidated is an amount nobody can trust past
   * the Dashboard's next edit. What the cache removes is the *wait*, and what
   * `primePricing()` below removes is the read happening on this page load at
   * all. Everything after the first read is free either way: the promise is
   * memoised for the service's lifetime, so `startProCheckout()` reuses it and
   * so does a second visit to `/pricing` in the same page load.
   *
   * **Failures are swallowed**, and the page shows whatever it had — a cached
   * amount, or a placeholder. A catalog that cannot be read is not something
   * the reader can act on at page load, and guessing an amount would be the
   * alarming answer to a question nobody asked (`CLAUDE.md` §4.4). The cause
   * is still reported the moment it matters — clicking Subscribe re-runs the
   * same lookup and shows the `SubscriptionError` it throws.
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
    // Started before anything is awaited, not inside it: this is the whole
    // reason the two waits cost one wait.
    const country = this.geoService.resolveCountry();

    // Nothing published yet this page load, so a cached catalog is the fastest
    // true answer available. Guarded on the signal rather than on a flag
    // because navigating away from `/pricing` and back re-runs this method,
    // and by then the network answer is already on screen.
    const cached = this.pricingCache.readCatalog();
    if (cached && this.proPriceOptionsSignal().length === 0) {
      this.publishProPrices(cached, this.geoService.knownCountry());
    }

    let options: readonly ProPriceOption[];
    try {
      options = await this.getProPrices();
    } catch {
      return;
    }
    // A currency is chosen from what is known *now* — the server's last answer
    // or the browser's time zone, neither of which needs a request — rather
    // than holding the radiogroup unchecked until the server answers. A
    // control with nothing checked for up to two seconds is worse than one
    // that moves once, and on a Brazilian machine this is already the right
    // answer, so it does not move at all.
    this.publishProPrices(options, this.geoService.knownCountry());
    this.publishProPrices(options, await country);
  }

  /**
   * Puts a resolved catalog on screen, and the selection back in step with it.
   *
   * The catalog itself is only re-published when it has actually changed —
   * see `sameProPriceOptions`. The *currency* rule runs every time regardless,
   * because the country it is given is what moves between calls.
   */
  private publishProPrices(options: readonly ProPriceOption[], country: string | null): void {
    if (!sameProPriceOptions(this.proPriceOptionsSignal(), options)) {
      this.proPriceOptionsSignal.set(options);
    }
    this.applyDefaultCurrency(options, country);
  }

  /**
   * Fetches everything `/pricing` needs, without rendering anything.
   *
   * Called when a reader shows they are heading there — hovering or focusing a
   * link to `/pricing` or "Upgrade to Pro" — and once per page load, on idle,
   * for a signed-in non-Pro reader (`primeOnIdle`). By the time the route
   * actually loads, the catalog promise is memoised and the country is
   * answered, so `loadProPrices()` above resolves without a round trip and the
   * `localStorage` copy is fresh for the visit after this one.
   *
   * **Deliberately not on every page load.** Two public reads per anonymous
   * visitor who never goes near the pricing page is the cost `loadProPrices()`
   * refuses to pay for a page they are not on; intent is what makes it worth
   * paying. Failures are ignored — nobody has asked for anything yet, and
   * `getProPrices()` does not cache a rejection, so the real attempt retries.
   */
  primePricing(): void {
    void this.getProPrices().catch(() => undefined);
    void this.geoService.resolveCountry();
  }

  /**
   * Primes once per page load for a reader who could actually buy — signed in,
   * with a real account, and not already subscribed.
   *
   * Called after the subscription read has answered, because "not already
   * subscribed" is what that read establishes; asking earlier would prime for
   * every Pro subscriber too, on a page they have no reason to open.
   *
   * The scheduled callback has no teardown and needs none: this service is
   * root-provided, so it lives exactly as long as the document the timer would
   * fire into (`CLAUDE.md` §4.4 is about a timer outliving its subject).
   */
  private primeOnIdle(): void {
    if (this.idlePrimeScheduled || this.isProUser()) {
      return;
    }
    this.idlePrimeScheduled = true;

    const run = () => this.primePricing();
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: IDLE_PRIME_TIMEOUT_MS });
    } else {
      setTimeout(run, IDLE_PRIME_FALLBACK_MS);
    }
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
      void this.proPricesPromise.then(
        // Written here rather than at the call site so that every way of
        // resolving the catalog — the pricing page, a prime, a Subscribe
        // click — leaves the same copy behind for the next page load.
        (options) => this.pricingCache.writeCatalog(options),
        () => {
          // Don't cache a failed lookup: a product fixed in the Dashboard
          // after a failed attempt should be picked up on the very next click,
          // not require a full page reload.
          this.proPricesPromise = null;
        },
      );
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
   * Redirects the browser to Stripe Checkout for the currency the reader is
   * being quoted — from a session created before they clicked, where there is
   * one.
   *
   * Three paths, in order:
   *
   * 1. **A URL is already waiting** for this account and this price
   *    (`prepareCheckout()` ran while they were reading). The redirect happens
   *    at once: no document write, no Eventarc delivery, no Stripe round trip
   *    on the click at all.
   * 2. **A handshake for the same price is in flight.** The click joins it
   *    rather than starting a second one — which would spend another slot of
   *    the `firestore.rules` volume cap and, worse, expire the session the
   *    first one is about to hand back.
   * 3. **Neither**, which is what a reader who was not eligible for
   *    pre-creation, or who clicked inside the first second, gets: the
   *    original create-then-poll path, unchanged.
   *
   * The signed-in check comes before the catalog lookup on purpose — an
   * anonymous *click* should cost a read no more than it should cost a
   * rejected write — and it is enforced again by `firestore.rules` regardless.
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
    const uid = this.requireSignedInUid('Sign in before subscribing.');
    const priceId = await this.selectedProPriceId();

    const ready = this.readyCheckoutFor(uid, priceId);
    if (ready) {
      window.location.assign(ready.url);
      return;
    }

    const pending = this.pendingCheckoutFor(uid, priceId);
    window.location.assign(await (pending ?? this.beginCheckoutHandshake(uid, priceId)));
  }

  /**
   * Creates the Checkout Session in the background, before anybody clicks.
   *
   * This is the half of the feature that removes the wait: the seconds
   * Subscribe used to spend were an Eventarc delivery, a cold start of
   * `createCheckoutSession`, Stripe's customer and session creation, and our
   * own 500 ms poll — none of which get faster, and all of which can happen
   * while the reader is still reading the card.
   *
   * **Only for a reader who could complete it**: a real, verified account that
   * is not already subscribed, on a page where the catalog has resolved and a
   * currency has settled. Anyone else would be spending a Stripe session and a
   * slot of the volume cap on a checkout that cannot happen — an anonymous
   * visitor's write is refused by `firestore.rules` outright, and an
   * unverified one has a refusal waiting on the click instead.
   *
   * Every exit is a no-op rather than an error. Nobody has asked for anything
   * yet, so there is nothing to report and nowhere to report it; a failure
   * simply leaves Subscribe on the path it took before, which reports the
   * cause itself. The caller decides *when* (`PricingComponent` waits a second
   * after the last currency change, so flicking the switch does not create a
   * session per flick).
   */
  async prepareCheckout(): Promise<void> {
    if (!this.isEligibleForPrecreatedCheckout()) {
      return;
    }
    const uid = this.signedInUid();
    const priceId = this.selectedProPrice()?.priceId;
    if (!uid || !priceId) {
      return;
    }
    // Already have one — nothing to do, and starting a handshake anyway would
    // expire the very session it would then replace.
    if (this.readyCheckoutFor(uid, priceId)) {
      return;
    }
    /**
     * **Any** handshake in flight, not merely one for this price.
     *
     * Two concurrent `createCheckoutSession` invocations race, because each
     * expires the customer's open sessions before creating its own: whichever
     * create lands second silently kills the other's session, and the client
     * that remembers the loser goes on believing its URL is live. A currency
     * change while a pre-creation was running is exactly how that happened.
     * Waiting costs the reader nothing worse than the click creating its own
     * session, which is what it did before pre-creation existed.
     */
    if (this.pendingCheckout) {
      return;
    }
    if (this.readyCheckoutUnstorable || !this.claimPrecreateSlot()) {
      return;
    }

    try {
      await this.beginCheckoutHandshake(uid, priceId);
    } catch {
      // See above: unasked-for work, so an unasked-for failure. Clicking
      // Subscribe runs the same handshake and shows what it says.
    }
  }

  /**
   * Whether pre-creating a session for the current reader is worth a Stripe
   * session and a slot of the volume cap.
   *
   * Reads the same two predicates `PricingComponent` renders the button from,
   * so the two cannot disagree about who is allowed to buy: a real account
   * (`isFullyAuthenticated` covers "signed in, not anonymous, and verified if
   * this is a password account") that is not already Pro.
   */
  private isEligibleForPrecreatedCheckout(): boolean {
    return this.authService.isFullyAuthenticated() && !this.isProUser();
  }

  /**
   * Writes the session document and waits for the URL, recording the attempt
   * so a click can join it and a completed one can be reused.
   *
   * Discarding whatever was ready *before* the write is not tidiness: the
   * function expires the customer's open sessions as part of creating this
   * one, so the old URL is dead from this moment and keeping it would hand the
   * reader an expired Stripe page.
   */
  private beginCheckoutHandshake(uid: string, priceId: string): Promise<string> {
    this.forgetReadyCheckout();

    const promise = this.runSessionHandshake(uid, {
      collectionName: 'checkout_sessions',
      payload: { price: priceId, origin: window.location.origin },
      timeoutMessage: 'Timed out waiting for Stripe checkout to start. Please try again.',
      failureMessage: 'Stripe checkout could not be started. Please try again.',
    });
    const attempt = { uid, priceId, promise };
    this.pendingCheckout = attempt;

    void promise.then(
      (url) => {
        // `!==` can only mean this attempt was abandoned — `prepareCheckout`
        // refuses to start a second while one is pending, so the only way a
        // newer one exists is a Subscribe click that could not wait.
        if (this.pendingCheckout === attempt) {
          this.pendingCheckout = null;
          this.rememberReadyCheckout({ uid, priceId, url, readyAt: Date.now() });
          // The reader may have changed currency while this was running, in
          // which case `prepareCheckout` turned itself away at the guard above
          // and nothing else will ask again. One retry, now that the slot is
          // free; it terminates because the next attempt is for whatever is
          // selected *then*, and the per-window ration bounds it regardless.
          if (this.selectedProPrice()?.priceId !== priceId) {
            void this.prepareCheckout();
          }
        }
      },
      () => {
        if (this.pendingCheckout === attempt) {
          this.pendingCheckout = null;
        }
        // Nothing is cached for a rejection (`CLAUDE.md` §4.4) — the next
        // click starts a fresh handshake rather than replaying this failure.
        // No retry here either: a failure is not a reason to spend another
        // session nobody asked for.
      },
    );

    return promise;
  }

  /**
   * The waiting session, if it is this account's, this price's, and still
   * usable.
   *
   * **Read from storage every time, never from a field.** The entry is
   * device-wide rather than tab-wide, so another tab can have replaced it (it
   * pre-created for itself) or cleared it (it started a handshake) since this
   * tab last looked — and a cached copy of a session that has since been
   * expired is precisely the thing that sends a reader to Stripe's "this
   * session has expired" page. A price that does not match means "create a
   * fresh one", which is correct rather than merely safe: the other tab's
   * session is in another currency and this reader is not buying that.
   */
  private readyCheckoutFor(uid: string, priceId: string): ReadyCheckout | null {
    const ready = this.pricingCache.readReadyCheckout();
    return ready && ready.uid === uid && ready.priceId === priceId ? ready : null;
  }

  private pendingCheckoutFor(uid: string, priceId: string): Promise<string> | null {
    const pending = this.pendingCheckout;
    return pending && pending.uid === uid && pending.priceId === priceId ? pending.promise : null;
  }

  private rememberReadyCheckout(entry: ReadyCheckout): void {
    if (!this.pricingCache.writeReadyCheckout(entry)) {
      this.readyCheckoutUnstorable = true;
    }
  }

  private forgetReadyCheckout(): void {
    this.pricingCache.clearReadyCheckout();
  }

  /**
   * Takes one of this window's pre-creation allowance, or refuses.
   *
   * The window is the same five minutes `firestore.rules` counts slots in, so
   * the budget here is a fraction of that cap rather than a number of its own.
   */
  private claimPrecreateSlot(): boolean {
    const currentWindow = Math.floor(Date.now() / SESSION_WINDOW_MS);
    if (currentWindow !== this.precreateWindow) {
      this.precreateWindow = currentWindow;
      this.precreatesInWindow = 0;
    }
    if (this.precreatesInWindow >= MAX_PRECREATED_SESSIONS_PER_WINDOW) {
      return false;
    }
    this.precreatesInWindow++;
    return true;
  }

  /**
   * Creates a Stripe billing portal session doc, waits for
   * `createPortalSession` (functions/src/billing-portal.ts) to write back a
   * hosted portal URL, and redirects the browser to it — lets a Pro
   * subscriber manage their payment method or cancel from Stripe's own UI.
   * Same doc-create-then-poll handshake as `startProCheckout` above, minus the
   * pre-creation: a billing portal is opened by people who have already
   * decided to, from a menu rather than a page, so there is no moment of
   * reading during which to prepare one.
   */
  async openBillingPortal(): Promise<void> {
    const uid = this.requireSignedInUid('Sign in before managing your subscription.');
    const portalUrl = await this.runSessionHandshake(uid, {
      collectionName: 'portal_sessions',
      payload: { origin: window.location.origin },
      timeoutMessage: 'Timed out waiting for the billing portal to open. Please try again.',
      failureMessage: 'Billing portal could not be opened. Please try again.',
    });
    window.location.assign(portalUrl);
  }

  /**
   * The signed-in, non-anonymous caller's uid, or a refusal written for the
   * screen.
   *
   * Also enforced by `firestore.rules`, but checked here first so an anonymous
   * caller never even creates a document that would just be rejected — and so
   * neither flow consults the catalog on their behalf.
   */
  private requireSignedInUid(signedOutMessage: string): string {
    const uid = this.signedInUid();
    if (!uid) {
      throw new SubscriptionError(signedOutMessage);
    }
    return uid;
  }

  /**
   * The uid a session document may be written under, read from auth rather
   * than from `trackedUid`.
   *
   * They agree in the end, but not at the same moment: `trackedUid` is set
   * from an `effect`, which is scheduled rather than immediate, and the pages
   * that write session documents are reacting to the same signal. Reading auth
   * directly means this never depends on which of the two ran first.
   */
  private signedInUid(): string | null {
    const user = this.authService.user();
    return user && !user.isAnonymous ? user.uid : null;
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
  private async runSessionHandshake(
    uid: string,
    options: {
      collectionName: 'checkout_sessions' | 'portal_sessions';
      payload: Record<string, string>;
      timeoutMessage: string;
      failureMessage: string;
    },
  ): Promise<string> {
    const sessionPath = await this.createSessionDoc(uid, options.collectionName, options.payload);

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
