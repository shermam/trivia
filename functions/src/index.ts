import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { createCheckoutSession } from './checkout-sessions';
export { stripeWebhook } from './webhook';
