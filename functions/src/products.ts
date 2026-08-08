import { getFirestore } from 'firebase-admin/firestore';
import type Stripe from 'stripe';
import { isSellableProPrice } from './checkout-request';

/**
 * Mirrors the Stripe product/price catalog into the public `products`/
 * `prices` Firestore collections — exactly what
 * `SubscriptionService.getProPriceId()` reads to resolve the current Pro
 * price without ever hardcoding it client-side.
 */
export async function syncProductToFirestore(product: Stripe.Product): Promise<void> {
  await getFirestore()
    .collection('products')
    .doc(product.id)
    .set(
      {
        active: product.active,
        name: product.name,
        description: product.description ?? null,
        role: (product.metadata?.['firebaseRole'] as string | undefined) ?? null,
        images: product.images ?? [],
      },
      { merge: true },
    );
}

export async function deleteProductFromFirestore(productId: string): Promise<void> {
  await getFirestore().collection('products').doc(productId).delete();
}

function resolveProductId(product: Stripe.Price['product']): string {
  return typeof product === 'string' ? product : product.id;
}

export async function syncPriceToFirestore(price: Stripe.Price): Promise<void> {
  await getFirestore()
    .collection('products')
    .doc(resolveProductId(price.product))
    .collection('prices')
    .doc(price.id)
    .set(
      {
        active: price.active,
        currency: price.currency,
        unit_amount: price.unit_amount,
        type: price.type,
        interval: price.recurring?.interval ?? null,
        interval_count: price.recurring?.interval_count ?? null,
      },
      { merge: true },
    );
}

export async function deletePriceFromFirestore(price: Stripe.Price): Promise<void> {
  await getFirestore()
    .collection('products')
    .doc(resolveProductId(price.product))
    .collection('prices')
    .doc(price.id)
    .delete();
}

/**
 * More Pro products than this and something is wrong with the Stripe setup,
 * not with the query — a bound here keeps a misconfigured catalog from turning
 * every checkout into an unbounded scan.
 */
const MAX_PRO_PRODUCTS = 5;

/**
 * Whether a client-supplied price ID is one this app sells — the catalog
 * lookup `firestore.rules` can't perform (`CLAUDE.md` §4.1).
 *
 * Filters on `role` alone rather than `role` *and* `active` so the query stays
 * a single equality filter served by the automatic single-field index;
 * `active` is checked in `isSellableProPrice` instead. `firestore.indexes.json`
 * stays empty, which is worth more than saving one document read.
 */
export async function isPriceSellableAsPro(priceId: string): Promise<boolean> {
  const products = await getFirestore()
    .collection('products')
    .where('role', '==', 'pro')
    .limit(MAX_PRO_PRODUCTS)
    .get();

  for (const product of products.docs) {
    const price = await product.ref.collection('prices').doc(priceId).get();
    if (price.exists && isSellableProPrice(product.data(), price.data())) {
      return true;
    }
  }
  return false;
}
