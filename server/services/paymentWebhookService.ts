import { subscriptionServerRepository } from '../repositories/subscriptionServerRepository';
import { ServerSubscription, SubscriptionStatus, PaymentProvider } from '../domain/subscriptionModel';
import { logger } from '../middlewares/logger';
import { WebhookSignatureVerifier } from './payments/webhookSignatureVerifier';

export interface WebhookEventPayload {
  provider: PaymentProvider;
  eventId: string;
  eventType: string;
  eventTimestamp?: number | string;
  data: { customerId: string; subscriptionId: string; userId?: string; status: string; planId?: 'PRO' | 'APEX_ELITE'; currentPeriodStart?: string; currentPeriodEnd?: string; amountCents?: number };
}
export interface HandleWebhookInput { payload: WebhookEventPayload; rawPayload?: string; signatureHeader?: string; timestampHeader?: string | number; }

const RECOGNIZED_EVENTS = new Set([
  'invoice.payment_succeeded','invoice.payment_failed','payment_intent.succeeded','payment_intent.payment_failed',
  'checkout.session.completed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted',
  'payment_succeeded','payment_failed','subscription_updated','pix.paid','pix.settled','pix.expired','pix.refunded','pix.failed',
]);

function mapStatus(eventType: string, status: string): SubscriptionStatus {
  if (eventType === 'customer.subscription.deleted' || eventType === 'pix.refunded' || status === 'canceled') return 'canceled';
  if (eventType.includes('payment_failed') || status === 'past_due') return 'past_due';
  if (status === 'expired') return 'expired';
  if (status === 'trialing') return 'trialing';
  if (eventType.includes('payment_succeeded') || status === 'active' || eventType === 'pix.paid' || eventType === 'pix.settled') return 'active';
  return 'pending';
}

export class PaymentWebhookService {
  async handleWebhook(inputOrPayload: WebhookEventPayload | HandleWebhookInput, signatureHeaderArg?: string, rawPayloadArg?: string, timestampHeaderArg?: string | number): Promise<{ processed: boolean; reason: string; subscription?: ServerSubscription }> {
    const isInputObject = 'payload' in inputOrPayload && typeof (inputOrPayload as any).payload === 'object';
    const payload = isInputObject ? (inputOrPayload as HandleWebhookInput).payload : inputOrPayload as WebhookEventPayload;
    const signatureHeader = isInputObject ? (inputOrPayload as HandleWebhookInput).signatureHeader : signatureHeaderArg;
    const rawPayload = isInputObject ? (inputOrPayload as HandleWebhookInput).rawPayload : rawPayloadArg;
    const timestampHeader = isInputObject ? (inputOrPayload as HandleWebhookInput).timestampHeader : timestampHeaderArg;
    const { provider, eventId, eventType, data, eventTimestamp } = payload;

    if (!signatureHeader?.trim()) return { processed: false, reason: 'MISSING_SIGNATURE' };
    const verification = WebhookSignatureVerifier.verify(provider, rawPayload || JSON.stringify(payload), signatureHeader, timestampHeader);
    if (!verification.valid) return { processed: false, reason: verification.reason };
    const claim = await subscriptionServerRepository.tryClaimWebhookEvent(provider, eventId, eventType);
    if (!claim.claimed && claim.alreadyProcessed) return { processed: true, reason: 'ALREADY_PROCESSED' };

    try {
      if (!RECOGNIZED_EVENTS.has(eventType)) {
        await subscriptionServerRepository.markWebhookCompleted(provider, eventId, eventType, 'ignored');
        return { processed: true, reason: 'UNKNOWN_EVENT_IGNORED' };
      }

      let userId = data.userId;
      if (!userId && data.subscriptionId) userId = (await subscriptionServerRepository.findBySubscriptionId(data.subscriptionId))?.userId;
      if (!userId) {
        await subscriptionServerRepository.markWebhookCompleted(provider, eventId, eventType, 'user_not_found');
        return { processed: false, reason: 'USER_NOT_FOUND' };
      }

      const existingSub = await subscriptionServerRepository.findByUserId(userId);
      if (existingSub && existingSub.updatedAt && eventTimestamp) {
        const incomingTime = typeof eventTimestamp === 'number' ? (eventTimestamp > 10000000000 ? eventTimestamp : eventTimestamp * 1000) : new Date(eventTimestamp).getTime();
        if (Number.isFinite(incomingTime) && incomingTime < new Date(existingSub.updatedAt).getTime()) {
          await subscriptionServerRepository.markWebhookCompleted(provider, eventId, eventType, 'out_of_order_ignored');
          return { processed: true, reason: 'OUT_OF_ORDER_EVENT_IGNORED', subscription: existingSub };
        }
      }

      const mappedStatus = mapStatus(eventType, data.status);
      const periodStart = data.currentPeriodStart || existingSub?.currentPeriodStart;
      const periodEnd = data.currentPeriodEnd || existingSub?.currentPeriodEnd;
      if (!periodStart || !periodEnd) {
        await subscriptionServerRepository.markWebhookCompleted(provider, eventId, eventType, 'missing_billing_period');
        return { processed: false, reason: 'MISSING_BILLING_PERIOD' };
      }

      const now = new Date().toISOString();
      const updatedSub = await subscriptionServerRepository.saveSubscription({
        id: existingSub?.id || `sub_${userId}`,
        userId,
        planId: data.planId || existingSub?.planId || 'PRO',
        status: mappedStatus,
        provider,
        customerId: data.customerId || existingSub?.customerId || '',
        subscriptionId: data.subscriptionId || existingSub?.subscriptionId || '',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: mappedStatus === 'canceled' ? true : existingSub?.cancelAtPeriodEnd ?? false,
        canceledAt: mappedStatus === 'canceled' ? existingSub?.canceledAt || now : existingSub?.canceledAt,
        renewAt: mappedStatus === 'active' ? periodEnd : existingSub?.renewAt,
        autoRenew: mappedStatus === 'active' || mappedStatus === 'trialing' ? !(existingSub?.cancelAtPeriodEnd ?? false) : false,
        createdAt: existingSub?.createdAt || now,
        updatedAt: now,
        priceBrl: data.amountCents ? data.amountCents / 100 : existingSub?.priceBrl || 0,
        lastPaymentDate: mappedStatus === 'active' ? now : existingSub?.lastPaymentDate,
      });

      await subscriptionServerRepository.markWebhookCompleted(provider, eventId, eventType, 'completed', { userId, status: mappedStatus, currentPeriodEnd: periodEnd });
      logger.info(`Webhook processado: ${provider} ${eventType} -> ${userId} ${mappedStatus}`);
      return { processed: true, reason: 'SUCCESS', subscription: updatedSub };
    } catch (error: any) {
      logger.error('Erro ao processar webhook internamente', { provider, eventId, error: error.message });
      await subscriptionServerRepository.releaseWebhookClaim(provider, eventId);
      throw error;
    }
  }

  async simulatePaymentApproval(_userId: string, _planSlug: 'PRO' | 'APEX_ELITE' = 'PRO', _method: PaymentProvider = 'pix_direct'): Promise<ServerSubscription> {
    throw new Error(process.env.NODE_ENV === 'production' ? 'SIMULATION_DISABLED_IN_PRODUCTION' : 'SIMULATION_ONLY_FOR_TESTS');
  }
}

export const paymentWebhookService = new PaymentWebhookService();
