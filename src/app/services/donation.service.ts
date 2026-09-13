import { Injectable, computed, inject, signal } from '@angular/core';
import { preferredCurrency } from '../utils/currency-preference.util';
import { AuthService } from './auth.service';
import { FirestoreRestClient, type RestDocument } from './firestore-rest/firestore-rest.client';
import { GeoService } from './geo.service';
import { SessionHandshakeService, SubscriptionError } from './session-handshake.service';

const PRODUCTS_COLLECTION = 'products';
const DONATION_TIMEOUT_MS = 20_000;

/**
 * The metadata value that marks a Stripe Product, and each of its Prices, as
 * part of the tip jar — the same convention `functions/src/checkout-request.ts`
 * validates against, restated here because the client and the server have to
 * agree on it and neither can import the other.
 */
const DONATION_KIND = 'donation';

/**
 * Ceilings on the catalog lookup, so neither query is unbounded (`CLAUDE.md`
 * §4.1 — every read needs a `where` *and* a `limit`).
 *
 * `MAX_DONATION_PRODUCTS` matches the server's own cap in
 * `functions/src/products.ts`: both ask the same question of the same
 * collection, and disagreeing about the answer's size would be a bug neither
 * side could see. There is one donation product; the cap only exists so a
 * Dashboard mistake cannot turn this into an unbounded read.
 */
const MAX_DONATION_PRODUCTS = 5;
const MAX_PRICES_PER_PRODUCT = 20;

/**
 * How many presets the dialog offers per currency.
 *
 * Three, because that is what the catalog is set up to carry (a small, a
 * medium and a large tip) and because a row of pills stops being a choice and
 * starts being a list somewhere past that. A currency priced with more is a
 * Dashboard decision this cannot honour without redesigning the row, so the
 * cheapest three win and the rest are ignored rather than rendered off the
 * edge.
 */
const MAX_PRESETS_PER_CURRENCY = 3;

/**
 * What a reader is told when the catalog carries no donation price at all.
 *
 * Says donations are not available rather than inviting a retry, because
 * nothing the reader does can change the answer: the catalog is written only
 * by `stripeWebhook`, and this is exactly what an environment looks like
 * before the donation Product has been created in the Stripe Dashboard
 * (`docs/stack.md` §2.4). Same shape, and the same reasoning, as
 * `NO_PRO_PRICE_MESSAGE`.
 */
export const NO_DONATION_PRICE_MESSAGE =
  "Donations aren't available right now — no donation amounts are set up. Please try again later.";

/** One preset the tip jar offers — a single mirrored one-time Stripe Price. */
export interface DonationPreset {
  /** The Stripe Price ID the donation session document carries. */
  readonly priceId: string;
  /** Lowercase ISO 4217, exactly as Stripe stores it (`usd`, `brl`). */
  readonly currency: string;
  /** The smallest unit of that currency — 500 for R$ 5,00. */
  readonly unitAmount: number;
}

/**
 * The mirrored price document as a preset, or `null` for anything that cannot
 * be offered as one.
 *
 * Checked rather than asserted, because these fields arrive from a Firestore
 * document: a price with no currency cannot be quoted, and a price with no
 * amount is one whose amount is decided at checkout, which is precisely the
 * client-chosen amount this feature refuses to have.
 */
function toDonationPreset(price: RestDocument): DonationPreset | null {
  const currency = price.data['currency'];
  const unitAmount = price.data['unit_amount'];
  if (typeof currency !== 'string' || currency === '') {
    return null;
  }
  if (typeof unitAmount !== 'number' || !Number.isFinite(unitAmount) || unitAmount <= 0) {
    return null;
  }
  return { priceId: price.id, currency: currency.toLowerCase(), unitAmount };
}

/**
 * The presets to offer per currency: the cheapest three, ascending.
 *
 * Sorted by amount rather than kept in catalog order, because the row reads as
 * small / medium / large and the Dashboard has no notion of the order prices
 * were created in. Ties are broken by price id so the result is deterministic
 * — two presets at the same amount is a Dashboard mistake, and one that must
 * not make the rendered row depend on which document came back first.
 */
export function presetsByCurrency(
  presets: readonly DonationPreset[],
): ReadonlyMap<string, readonly DonationPreset[]> {
  const byCurrency = new Map<string, DonationPreset[]>();
  for (const preset of presets) {
    const existing = byCurrency.get(preset.currency);
    if (existing) {
      existing.push(preset);
    } else {
      byCurrency.set(preset.currency, [preset]);
    }
  }
  for (const [currency, options] of byCurrency) {
    const sorted = [...options].sort(
      (a, b) => a.unitAmount - b.unitAmount || a.priceId.localeCompare(b.priceId),
    );
    byCurrency.set(currency, sorted.slice(0, MAX_PRESETS_PER_CURRENCY));
  }
  return byCurrency;
}

/**
 * The tip jar: what a donation costs, in which currency, and the handshake
 * that turns a chosen preset into a Stripe Checkout page.
 *
 * A sibling of `SubscriptionService` rather than a part of it, because the two
 * sell different things through the same machinery — and everything the two
 * genuinely share is shared: the write-then-poll handshake
 * (`SessionHandshakeService`), the country signal (`GeoService`) and the rule
 * that turns a country into a currency (`preferredCurrency`). What is not
 * shared is the catalog and the session subcollection, deliberately: separate
 * volume caps, separate server-side validation, and a donation price that can
 * never be sold as Pro.
 *
 * **Anyone signed in may donate, anonymous sessions included.** Donating is
 * not a privilege; friction in front of it costs donations and protects
 * nothing. What the account decides is only whether the donation can be
 * attributed, which is what `isGuest` below tells the dialog to say before
 * anybody pays.
 */
@Injectable({ providedIn: 'root' })
export class DonationService {
  private readonly authService = inject(AuthService);
  private readonly rest = inject(FirestoreRestClient);
  private readonly geoService = inject(GeoService);
  private readonly handshake = inject(SessionHandshakeService);

  private presetsPromise: Promise<readonly DonationPreset[]> | null = null;

  private readonly presetsByCurrencySignal = signal<ReadonlyMap<string, readonly DonationPreset[]>>(
    new Map(),
  );
  private readonly selectedCurrencySignal = signal<string | null>(null);
  private readonly selectedPriceIdSignal = signal<string | null>(null);
  private readonly catalogResolvedSignal = signal(false);

  /**
   * Whether the reader has picked a currency themselves.
   *
   * The catalog and the server's answer about where they are arrive at
   * different times, and the reader can click in between. A default landing
   * after that click would silently undo it, on the one control whose whole
   * purpose is to override the guess — the same rule `SubscriptionService`
   * applies on the pricing page.
   */
  private currencyChosenByReader = false;

  /** Every currency the tip jar is priced in, in catalog order. */
  readonly currencies = computed(() => [...this.presetsByCurrencySignal().keys()]);

  /** The currency the reader is being quoted, or `null` before the catalog lands. */
  readonly selectedCurrency = this.selectedCurrencySignal.asReadonly();

  /** The three presets for that currency — empty until the catalog has answered. */
  readonly presets = computed<readonly DonationPreset[]>(
    () => this.presetsByCurrencySignal().get(this.selectedCurrencySignal() ?? '') ?? [],
  );

  /** Which preset is checked. */
  readonly selectedPriceId = this.selectedPriceIdSignal.asReadonly();

  /**
   * Whether the catalog read has finished, however it finished.
   *
   * The dialog needs the three states apart: still loading (say nothing),
   * resolved with presets (offer them), resolved with none (say donations are
   * not set up). Without this the empty case is indistinguishable from the
   * first frame, and the dialog would tell every reader donations were
   * unavailable for as long as the read took — the alarming guess `CLAUDE.md`
   * §4.4 is about.
   */
  readonly catalogResolved = this.catalogResolvedSignal.asReadonly();

  /** True once the read has finished and found nothing to offer. */
  readonly isUnavailable = computed(
    () => this.catalogResolvedSignal() && this.presetsByCurrencySignal().size === 0,
  );

  /**
   * Whether this donation cannot be attributed to an account.
   *
   * Gated on auth having resolved, so the notice never flashes at somebody
   * whose account is a frame away from arriving (`CLAUDE.md` §4.4: a state
   * that depends on data still loading defaults to the least alarming
   * outcome). An anonymous session and no session at all are the same case
   * here — neither can be credited — but only once we know which it is.
   */
  readonly isGuest = computed(() => this.authService.authReady() && !this.showsRealAccount());

  private readonly showsRealAccount = computed(() => {
    const user = this.authService.user();
    return user !== null && !user.isAnonymous;
  });

  /**
   * Resolves the presets and settles on a currency — called when the dialog
   * opens, not on page load.
   *
   * **Deliberately not primed.** The pricing page pays for its catalog read
   * ahead of time because it has to *render* a price; the tip jar renders
   * nothing until somebody opens it, and two public reads on every page load
   * for a dialog most readers never open is the cost `SubscriptionService`
   * already refuses to pay for `/pricing`.
   *
   * The country lookup is started first and awaited last, so the two round
   * trips overlap; the synchronous answer (`knownCountry`) settles the switch
   * in the meantime, so on a Brazilian machine the right currency is checked
   * from the first frame the control exists and never moves.
   *
   * Failures are swallowed and leave the dialog on its loading state, which
   * resolves to the unavailable message — the same message an empty catalog
   * produces, because from the reader's side they are the same thing and
   * neither is something they can act on.
   */
  async loadPresets(): Promise<void> {
    const country = this.geoService.resolveCountry();
    try {
      const presets = await this.getPresets();
      this.publishPresets(presets, this.geoService.knownCountry());
      this.publishPresets(presets, await country);
    } catch {
      this.catalogResolvedSignal.set(true);
    }
  }

  /** Quotes the reader in another of the currencies the tip jar is priced in. */
  selectCurrency(currency: string): void {
    if (!this.presetsByCurrencySignal().has(currency)) {
      // A currency with no presets behind it would leave the row empty and the
      // Donate button unable to name a price, so it is ignored rather than
      // stored — and not recorded as a choice either, since the reader has not
      // successfully chosen anything.
      return;
    }
    // The reader's *rank* is kept, not their price id: somebody on the middle
    // amount in dollars means the middle amount in reais, not whichever real
    // price happens to be nearest 5 USD.
    const rank = Math.max(
      0,
      this.presets().findIndex((preset) => preset.priceId === this.selectedPriceIdSignal()),
    );
    this.currencyChosenByReader = true;
    this.selectedCurrencySignal.set(currency);
    this.selectPresetByRank(rank);
  }

  selectPreset(priceId: string): void {
    if (this.presets().some((preset) => preset.priceId === priceId)) {
      this.selectedPriceIdSignal.set(priceId);
    }
  }

  /**
   * Redirects the browser to Stripe Checkout for the preset the reader chose.
   *
   * No pre-creation, unlike Pro. A donation dialog is opened by somebody who
   * has already decided to donate and is two clicks from paying, so there is
   * no window of reading during which to prepare a session — and preparing one
   * per dialog open would spend a Stripe session and a slot of the volume cap
   * on every idle glance.
   */
  async startDonation(): Promise<void> {
    // **Waits for the session rather than requiring one to be there already.**
    // The donation is written as a document owned by this uid, so there is no
    // version of this that proceeds without one — and since the bootstrap
    // moved after first paint (`FEAT-017` §3.2) a reader who opens the dialog
    // from the footer and clicks straight through can arrive before the
    // anonymous session does. `DonationDialogStateService.open()` starts it so
    // this is normally already resolved; the await is what makes a fast click
    // wait a moment instead of being refused. Idempotent, and it swallows its
    // own failures rather than rejecting.
    await this.authService.ensureSignedIn();
    const uid = this.authService.user()?.uid;
    if (!uid) {
      // Not "still starting up" any more: the bootstrap has been awaited, so
      // the only way to be here is that auth could not be reached at all.
      // Generic, because this cannot tell offline from misconfigured and a
      // message must not narrate a cause it did not check (`CLAUDE.md` §4.4).
      throw new SubscriptionError('Could not start the donation. Please try again.');
    }
    const priceId = this.selectedPriceIdSignal();
    if (!priceId) {
      throw new SubscriptionError(NO_DONATION_PRICE_MESSAGE);
    }

    const url = await this.handshake.run(uid, {
      collectionName: 'donation_sessions',
      payload: { price: priceId, origin: window.location.origin },
      timeoutMessage: 'Timed out waiting for the donation page to open. Please try again.',
      failureMessage: 'The donation could not be started. Please try again.',
    });
    window.location.assign(url);
  }

  /**
   * Puts a resolved catalog on screen and the selection back in step with it.
   *
   * Runs twice per open — once on what is known without asking, once on the
   * server's answer — so it has to be idempotent and has to respect a choice
   * made in between.
   */
  private publishPresets(presets: readonly DonationPreset[], country: string | null): void {
    const byCurrency = presetsByCurrency(presets);
    this.presetsByCurrencySignal.set(byCurrency);
    this.catalogResolvedSignal.set(true);

    const offered = [...byCurrency.keys()];
    const stillOffered = offered.includes(this.selectedCurrencySignal() ?? '');
    if (stillOffered && this.currencyChosenByReader) {
      return;
    }
    const currency = preferredCurrency(offered, country);
    const changed = currency !== this.selectedCurrencySignal();
    this.selectedCurrencySignal.set(currency);
    if (changed || !this.selectedPriceIdSignal()) {
      // The middle amount, so the radiogroup is never rendered with nothing
      // checked and the default is the one a reader is most likely to mean.
      this.selectPresetByRank(Math.floor((this.presets().length - 1) / 2));
    }
  }

  private selectPresetByRank(rank: number): void {
    const presets = this.presets();
    this.selectedPriceIdSignal.set(presets[Math.min(rank, presets.length - 1)]?.priceId ?? null);
  }

  private getPresets(): Promise<readonly DonationPreset[]> {
    if (!this.presetsPromise) {
      this.presetsPromise = this.loadDonationPrices();
      void this.presetsPromise.catch(() => {
        // Don't cache a failed lookup (`CLAUDE.md` §4.4): a catalog created in
        // the Dashboard after a failed attempt should be picked up the next
        // time the dialog opens, not after a page reload.
        this.presetsPromise = null;
      });
    }
    return this.presetsPromise;
  }

  /**
   * Reads the donation catalog `stripeWebhook` mirrors from the Stripe
   * Dashboard (`functions/src/products.ts`) — so no amount is ever hardcoded
   * here, and changing what a coffee costs needs no frontend deploy.
   *
   * **Selects on `kind`, matching the server.** `createDonationSession` accepts
   * a price only if it belongs to an active product carrying `kind:
   * 'donation'` and carries that marker itself, so the client has to ask the
   * same question or it would offer a price the server is bound to reject.
   * Both queries are bounded and the per-product ones run in parallel.
   */
  private async loadDonationPrices(): Promise<readonly DonationPreset[]> {
    const products = await this.rest.runQuery(
      {
        collectionPath: PRODUCTS_COLLECTION,
        where: [{ field: 'kind', op: 'EQUAL', value: DONATION_KIND }],
        limit: MAX_DONATION_PRODUCTS,
      },
      { timeoutMs: DONATION_TIMEOUT_MS },
    );

    // Every clause the server applies, not most of them (`CLAUDE.md` §4.2): a
    // product carrying both `kind: 'donation'` and `firebaseRole: 'pro'` is a
    // Dashboard mistake nothing prevents, and `isSellableDonationPrice`
    // refuses it — so a client that checked only `active` would render presets
    // the server is bound to reject, which the reader meets as a Donate button
    // that cannot work.
    const activeProducts = products.filter(
      (product) => product.data['active'] === true && product.data['role'] !== 'pro',
    );

    const priceLists = await Promise.all(
      activeProducts.map(async (product) => {
        const prices = await this.rest.runQuery(
          {
            collectionPath: `${PRODUCTS_COLLECTION}/${product.id}/prices`,
            where: [{ field: 'active', op: 'EQUAL', value: true }],
            limit: MAX_PRICES_PER_PRODUCT,
          },
          { timeoutMs: DONATION_TIMEOUT_MS },
        );
        return prices
          .filter(
            (price) => price.data['type'] === 'one_time' && price.data['kind'] === DONATION_KIND,
          )
          .map(toDonationPreset)
          .filter((preset): preset is DonationPreset => preset !== null);
      }),
    );

    return priceLists.flat();
  }
}
