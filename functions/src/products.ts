import { getFirestore } from 'firebase-admin/firestore';
import type Stripe from 'stripe';
import { DONATION_KIND, isSellableDonationPrice, isSellableProPrice } from './checkout-request';
import { deleteIfNotStale, setIfNotStale } from './event-order';

/**
 * Mirrors the Stripe product/price catalog into the public `products`/
 * `prices` Firestore collections — exactly what
 * `SubscriptionService.getProPrices()` reads to resolve the current Pro
 * prices (one per currency) without ever hardcoding one client-side, and what
 * `DonationService` reads to resolve the donation presets.
 *
 * **Two metadata keys survive the mirror, and they answer different
 * questions.** `firebaseRole` becomes `role` and says which entitlement a
 * subscription to this product grants; `kind` becomes `kind` and says what
 * sort of thing this is at all — `donation` for the tip jar, absent for
 * everything else. Both are copied at *both* levels, because both levels are
 * read: the product's decides which products a catalog query returns, and the
 * price's is what stops a Pro price and a donation price on the same account
 * being interchangeable (`isSellableDonationPrice`).
 */
export async function syncProductToFirestore(
  product: Stripe.Product,
  eventCreated: number,
): Promise<boolean> {
  return setIfNotStale(
    getFirestore().collection('products').doc(product.id),
    {
      active: product.active,
      name: product.name,
      description: product.description ?? null,
      role: (product.metadata?.['firebaseRole'] as string | undefined) ?? null,
      kind: (product.metadata?.['kind'] as string | undefined) ?? null,
      images: product.images ?? [],
    },
    eventCreated,
  );
}

export async function deleteProductFromFirestore(
  productId: string,
  eventCreated: number,
): Promise<boolean> {
  return deleteIfNotStale(getFirestore().collection('products').doc(productId), eventCreated);
}

function resolveProductId(product: Stripe.Price['product']): string {
  return typeof product === 'string' ? product : product.id;
}

export async function syncPriceToFirestore(
  price: Stripe.Price,
  eventCreated: number,
): Promise<boolean> {
  return setIfNotStale(
    priceRef(price),
    {
      active: price.active,
      currency: price.currency,
      unit_amount: price.unit_amount,
      type: price.type,
      kind: (price.metadata?.['kind'] as string | undefined) ?? null,
      interval: price.recurring?.interval ?? null,
      interval_count: price.recurring?.interval_count ?? null,
    },
    eventCreated,
  );
}

export async function deletePriceFromFirestore(
  price: Stripe.Price,
  eventCreated: number,
): Promise<boolean> {
  return deleteIfNotStale(priceRef(price), eventCreated);
}

function priceRef(price: Stripe.Price) {
  return getFirestore()
    .collection('products')
    .doc(resolveProductId(price.product))
    .collection('prices')
    .doc(price.id);
}

/**
 * More products of one kind than this and something is wrong with the Stripe
 * setup, not with the query — a bound here keeps a misconfigured catalog from
 * turning every checkout into an unbounded scan.
 */
const MAX_SELLABLE_PRODUCTS = 5;

/**
 * Whether a client-supplied price ID is one this app sells — the catalog
 * lookup `firestore.rules` can't perform (`CLAUDE.md` §4.1).
 *
 * Filters on `role` alone rather than `role` *and* `active` so the query stays
 * a single equality filter served by the automatic single-field index;
 * `active` is checked in `isSellableProPrice` instead. Not needing a composite
 * index for this is worth more than saving one document read.
 * `SubscriptionService.getProPrices()` filters the same way, for the same
 * reason and so the two agree on what a Pro product is.
 */
export async function isPriceSellableAsPro(priceId: string): Promise<boolean> {
  return catalogHolds(priceId, { field: 'role', value: 'pro' }, isSellableProPrice);
}

/**
 * The same lookup for the donation catalog: is this price ID one of the
 * presets the tip jar is priced from?
 *
 * Filters on `kind` for the same reason the Pro lookup filters on `role`
 * alone — one equality filter is served by the automatic single-field index,
 * where a second field would need a composite one — and `DonationService`
 * queries the catalog exactly the same way, so the two agree on what a
 * donation product is.
 */
export async function isPriceSellableAsDonation(priceId: string): Promise<boolean> {
  return catalogHolds(priceId, { field: 'kind', value: DONATION_KIND }, isSellableDonationPrice);
}

/**
 * Whether some product this app sells carries `priceId`, and whether that
 * pairing satisfies `isSellable`.
 *
 * One implementation for both catalogs, because the shape of the question is
 * identical and only the marker differs — the alternative was two loops that
 * could drift in their bound, their filter or their `exists` check.
 */
async function catalogHolds(
  priceId: string,
  marker: { field: string; value: string },
  isSellable: (
    product: Record<string, unknown> | undefined,
    price: Record<string, unknown> | undefined,
  ) => boolean,
): Promise<boolean> {
  const products = await getFirestore()
    .collection('products')
    .where(marker.field, '==', marker.value)
    .limit(MAX_SELLABLE_PRODUCTS)
    .get();

  for (const product of products.docs) {
    const price = await product.ref.collection('prices').doc(priceId).get();
    if (price.exists && isSellable(product.data(), price.data())) {
      return true;
    }
  }
  return false;
}
