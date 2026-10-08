import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { deleteAccount, exportAccountData } from './account';
export { recordGameResult } from './user-stats';
export { sweepPlayHistory } from './play-history-sweep';
export { createCheckoutSession } from './checkout-sessions';
export { createDonationSession } from './donation-sessions';
export { createPortalSession } from './billing-portal';
export { geo } from './geo';
export { stripeWebhook } from './webhook';
