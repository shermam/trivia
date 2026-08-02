import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStripeClient, isMockMode } from './stripe-client';

/**
 * Returns the Stripe customer ID for this Firebase user, creating both the
 * Stripe customer and the `customers/{uid}` Firestore doc on first use.
 * Idempotent — safe to call on every checkout, not just the first.
 */
export async function getOrCreateStripeCustomerId(uid: string): Promise<string> {
  const customerRef = getFirestore().collection('customers').doc(uid);
  const existing = (await customerRef.get()).data()?.['stripeId'] as string | undefined;
  if (existing) {
    return existing;
  }

  if (isMockMode()) {
    const mockCustomerId = `cus_mock_${uid}`;
    await customerRef.set({ stripeId: mockCustomerId }, { merge: true });
    return mockCustomerId;
  }

  const authUser = await getAuth().getUser(uid);
  const stripe = getStripeClient();
  const customer = await stripe.customers.create({
    email: authUser.email,
    metadata: { firebaseUID: uid },
  });
  await customerRef.set({ stripeId: customer.id }, { merge: true });
  return customer.id;
}
