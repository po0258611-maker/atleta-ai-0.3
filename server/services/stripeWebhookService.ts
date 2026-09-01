import { SERVER_CONFIG } from '../config/env';
import { getPaidPlan } from '../config/plans';
import { subscriptionServerRepository } from '../repositories/subscriptionServerRepository';
import { paymentRepository } from '../repositories/paymentRepository';
import { PaymentWebhookService } from './paymentWebhookService';
import { WebhookSignatureVerifier } from './payments/webhookSignatureVerifier';

interface StripeEvent { id: string; type: string; created?: number; data?: { object?: any } }

const SUCCESS_EVENTS = new Set(['checkout.session.completed', 'invoice.payment_succeeded']);
const FAILURE_EVENTS = new Set(['invoice.payment_failed']);
const SUBSCRIPTION_EVENTS = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']);
const SUPPORTED_EVENTS = new Set([...SUCCESS_EVENTS, ...FAILURE_EVENTS, ...SUBSCRIPTION_EVENTS]);

function expectedPlanByPriceId(priceId: unknown): 'PRO' | 'APEX_ELITE' | null {
  if (priceId === SERVER_CONFIG.STRIPE_PRO_PRICE_ID) return 'PRO';
  if (priceId === SERVER_CONFIG.STRIPE_APEX_ELITE_PRICE_ID) return 'APEX_ELITE';
  return null;
}

function normalizeCurrency(value: unknown): string { return typeof value === 'string' ? value.toLowerCase() : ''; }
function asPositiveInteger(value: unknown): number | null { return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null; }
function subscriptionPriceId(object: any): string | null { return object?.items?.data?.[0]?.price?.id || object?.lines?.data?.[0]?.price?.id || null; }

function toIsoUnix(value: unknown): string | undefined {
  return typeof value === 'number' && value > 0 ? new Date(value * 1000).toISOString() : undefined;
}

function subscriptionPeriod(object: any): { start?: string; end?: string } {
  return {
    start: toIsoUnix(object?.current_period_start) || toIsoUnix(object?.lines?.data?.[0]?.period?.start),
    end: toIsoUnix(object?.current_period_end) || toIsoUnix(object?.lines?.data?.[0]?.period?.end),
  };
}

function mapStripeSubscriptionStatus(status: unknown): string {
  switch (status) {
    case 'active': return 'active';
    case 'trialing': return 'trialing';
    case 'canceled': return 'canceled';
    case 'past_due':
    case 'unpaid':
    case 'incomplete': return 'past_due';
    case 'incomplete_expired': return 'expired';
    default: return 'past_due';
  }
}

export class StripeWebhookService {
  private readonly genericWebhookService = new PaymentWebhookService();

  async handle(rawPayload: string, signatureHeader: string | undefined): Promise<{ processed: boolean; reason: string }> {
    const verification = WebhookSignatureVerifier.verifyStripe(rawPayload, signatureHeader, SERVER_CONFIG.STRIPE_WEBHOOK_SECRET);
    if (!verification.valid) return { processed: false, reason: verification.reason };

    let event: StripeEvent;
    try { event = JSON.parse(rawPayload) as StripeEvent; } catch { return { processed: false, reason: 'INVALID_JSON' }; }
    if (!event.id || !event.type || !event.data?.object) return { processed: false, reason: 'INVALID_STRIPE_EVENT' };
    if (!SUPPORTED_EVENTS.has(event.type)) return { processed: true, reason: 'UNSUPPORTED_EVENT_IGNORED' };

    const object = event.data.object;
    const metadata = object?.metadata || {};
    const customerId = typeof object?.customer === 'string' ? object.customer : null;
    const subscriptionId = typeof object?.subscription === 'string'
      ? object.subscription
      : (typeof object?.id === 'string' && event.type.startsWith('customer.subscription.') ? object.id : null);
    const userId = typeof metadata.user_id === 'string' && metadata.user_id ? metadata.user_id : undefined;

    if (!customerId && !subscriptionId) return { processed: false, reason: 'MISSING_STRIPE_IDENTIFIERS' };

    let planId: 'PRO' | 'APEX_ELITE' | undefined;
    const priceId = subscriptionPriceId(object) || metadata.price_id;
    if (priceId) planId = expectedPlanByPriceId(priceId) || undefined;
    if (!planId && metadata.plan_slug === 'PRO') planId = 'PRO';
    if (!planId && metadata.plan_slug === 'APEX_ELITE') planId = 'APEX_ELITE';
    if (event.type !== 'customer.subscription.deleted' && !planId) return { processed: false, reason: 'INVALID_STRIPE_PRICE' };

    const plan = planId ? getPaidPlan(planId) : null;
    const expectedAmount = plan?.amountCents;
    const amount = asPositiveInteger(object?.amount_total) ?? asPositiveInteger(object?.amount_paid) ?? asPositiveInteger(object?.amount_received) ?? asPositiveInteger(object?.amount);

    if (event.type === 'checkout.session.completed' || event.type === 'invoice.payment_succeeded') {
      if (normalizeCurrency(object?.currency) !== 'brl') return { processed: false, reason: 'INVALID_CURRENCY' };
      if (amount === null || expectedAmount === undefined || amount !== expectedAmount) return { processed: false, reason: 'INVALID_AMOUNT' };
      if (event.type === 'checkout.session.completed' && !['paid', 'no_payment_required'].includes(object?.payment_status)) return { processed: false, reason: 'PAYMENT_NOT_SETTLED' };
    }

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      if (!priceId || !expectedPlanByPriceId(priceId)) return { processed: false, reason: 'INVALID_STRIPE_PRICE' };
      if (normalizeCurrency(object?.items?.data?.[0]?.price?.currency) !== 'brl') return { processed: false, reason: 'INVALID_CURRENCY' };
      const unitAmount = asPositiveInteger(object?.items?.data?.[0]?.price?.unit_amount);
      if (unitAmount === null || expectedAmount === undefined || unitAmount !== expectedAmount) return { processed: false, reason: 'INVALID_AMOUNT' };
    }

    if (event.type === 'customer.subscription.deleted' && priceId && !expectedPlanByPriceId(priceId)) return { processed: false, reason: 'INVALID_STRIPE_PRICE' };

    const existing = subscriptionId ? await subscriptionServerRepository.findBySubscriptionId(subscriptionId) : null;
    const resolvedUserId = userId || existing?.userId;
    if (!resolvedUserId) return { processed: false, reason: 'USER_NOT_FOUND' };

    const period = subscriptionPeriod(object);
    let status = 'active';
    if (event.type.startsWith('customer.subscription.')) status = mapStripeSubscriptionStatus(object?.status);
    else if (event.type === 'invoice.payment_failed') status = 'past_due';
    else if (event.type === 'customer.subscription.deleted') status = 'canceled';

    const result = await this.genericWebhookService.handleWebhook({
      payload: {
        provider: 'stripe',
        eventId: event.id,
        eventType: event.type,
        eventTimestamp: event.created ? event.created * 1000 : undefined,
        data: {
          customerId: customerId || existing?.customerId || '',
          subscriptionId: subscriptionId || existing?.subscriptionId || '',
          userId: resolvedUserId,
          status,
          planId: planId || existing?.planId,
          currentPeriodStart: period.start || existing?.currentPeriodStart,
          currentPeriodEnd: period.end || existing?.currentPeriodEnd,
          amountCents: amount ?? expectedAmount,
        },
      },
      rawPayload,
      signatureHeader,
    });

    if (result.processed) {
      if (event.type === 'checkout.session.completed' && typeof object.id === 'string') {
        await paymentRepository.updateStatus(object.id, 'approved');
      } else if (subscriptionId && SUCCESS_EVENTS.has(event.type)) {
        await paymentRepository.updateStatusBySubscriptionId(subscriptionId, 'approved');
      } else if (subscriptionId && FAILURE_EVENTS.has(event.type)) {
        await paymentRepository.updateStatusBySubscriptionId(subscriptionId, 'failed');
      }
    }

    return { processed: result.processed, reason: result.reason };
  }
}

export const stripeWebhookService = new StripeWebhookService();
