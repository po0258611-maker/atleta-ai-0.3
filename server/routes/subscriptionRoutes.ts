import { Router } from 'express';
import {
  handlePaymentWebhook,
  handleCreatePaymentIntent,
  handleCheckPaymentStatus,
  handleGetSubscriptionHistory,
  handleCancelSubscription,
  handleReactivateSubscription,
  handleChangePlan,
} from '../controllers/subscriptionController';
import { handleStripeWebhook } from '../controllers/stripeWebhookController';
import { requireAuth } from '../middlewares/auth';

export const subscriptionRouter = Router();

// Stripe has a provider-specific payload contract and must be validated against the raw body.
subscriptionRouter.post('/webhooks/stripe', handleStripeWebhook);

// Generic/legacy webhook handler for non-Stripe providers.
subscriptionRouter.post('/webhooks/:provider', handlePaymentWebhook);

// Payment Intents & Orders (Requires Firebase Auth Bearer Token)
subscriptionRouter.post('/create-intent', requireAuth, handleCreatePaymentIntent);
subscriptionRouter.get('/status/:transactionId', requireAuth, handleCheckPaymentStatus);
subscriptionRouter.get('/history', requireAuth, handleGetSubscriptionHistory);

// Subscription Lifecycle Management (Authoritative backend operations)
subscriptionRouter.post('/cancel', requireAuth, handleCancelSubscription);
subscriptionRouter.post('/reactivate', requireAuth, handleReactivateSubscription);
subscriptionRouter.post('/change-plan', requireAuth, handleChangePlan);
