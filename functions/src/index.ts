import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { deleteAccount } from './account';
export { createCheckoutSession } from './checkout-sessions';
export { createPortalSession } from './billing-portal';
export { stripeWebhook } from './webhook';
