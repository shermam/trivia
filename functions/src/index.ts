import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { deleteAccount, exportAccountData } from './account';
export { recordGameResult } from './user-stats';
export { createCheckoutSession } from './checkout-sessions';
export { createPortalSession } from './billing-portal';
export { stripeWebhook } from './webhook';
