import { getFirestore } from 'firebase-admin/firestore';
import type Stripe from 'stripe';

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
