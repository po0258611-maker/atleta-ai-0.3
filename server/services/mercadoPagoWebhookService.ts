import { SERVER_CONFIG } from '../config/env';
import { getPaidPlan, PaidPlanSlug } from '../config/plans';
import { subscriptionServerRepository } from '../repositories/subscriptionServerRepository';
import { logger } from '../middlewares/logger';
import { MercadoPagoPixProvider } from './payments/mercadoPagoPixProvider';

interface MercadoPagoNotification {
  id?: number | string;
  action?: string;
  type?: string;
  data?: { id?: string | number };
  date_created?: string;
}

interface PaymentSnapshot {
  id?: number | string;
  status?: string;
  transaction_amount?: number;
  external_reference?: string;
}

function decodeReference(reference?: string): { userId: string; planSlug: PaidPlanSlug } | null {
  if (!reference) return null;
  try {
    const parsed = JSON.parse(Buffer.from(reference, 'base64url').toString('utf8')) as {
      userId?: unknown;
      planSlug?: unknown;
    };
    if (typeof parsed.userId !== 'string' || !parsed.userId || typeof parsed.planSlug !== 'string') return null;
    const plan = getPaidPlan(parsed.planSlug);
    return plan ? { userId: parsed.userId, planSlug: parsed.planSlug as PaidPlanSlug } : null;
  } catch {
    return null;
  }
}

export class MercadoPagoWebhookService {
  private provider = new MercadoPagoPixProvider();

  async handle(notification: MercadoPagoNotification, dataId: string, xSignature?: string, xRequestId?: string) {
    if (notification.type && notification.type !== 'payment') {
      return { processed: true, reason: 'IGNORED_EVENT_TYPE' };
    }

    const verification = MercadoPagoPixProvider.verifyWebhookSignature(
      xSignature,
      xRequestId,
      dataId,
      SERVER_CONFIG.MERCADOPAGO_WEBHOOK_SECRET,
    );

    if (!verification.valid) {
      logger.warn('Mercado Pago webhook rejected', { reason: verification.reason, dataId });
      throw new Error(`MERCADOPAGO_WEBHOOK_${verification.reason}`);
    }

    const eventId = notification.id ? String(notification.id) : `${dataId}:${notification.action || 'payment.updated'}`;
    const eventType = notification.action || 'payment.updated';
    const claim = await subscriptionServerRepository.tryClaimWebhookEvent('mercadopago', eventId, eventType);

    if (!claim.claimed && claim.alreadyProcessed) {
      return { processed: true, reason: 'ALREADY_PROCESSED' };
    }

    try {
      const payment = await this.provider.getPayment(dataId) as PaymentSnapshot;
      const reference = decodeReference(payment.external_reference);
      if (!reference) {
        await subscriptionServerRepository.markWebhookCompleted('mercadopago', eventId, eventType, 'invalid_reference');
        return { processed: false, reason: 'INVALID_EXTERNAL_REFERENCE' };
      }

      const plan = getPaidPlan(reference.planSlug);
      if (!plan) {
        await subscriptionServerRepository.markWebhookCompleted('mercadopago', eventId, eventType, 'invalid_plan');
        return { processed: false, reason: 'INVALID_PLAN' };
      }

      const actualAmountCents = Math.round(Number(payment.transaction_amount) * 100);
      if (!Number.isFinite(actualAmountCents) || actualAmountCents !== plan.amountCents) {
        await subscriptionServerRepository.markWebhookCompleted('mercadopago', eventId, eventType, 'amount_mismatch');
        return { processed: false, reason: 'AMOUNT_MISMATCH' };
      }

      const existing = await subscriptionServerRepository.findByUserId(reference.userId);
      const now = new Date();

      if (payment.status === 'approved') {
        const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const subscription = await subscriptionServerRepository.saveSubscription({
          id: existing?.id || `sub_${reference.userId}`,
          userId: reference.userId,
          planId: reference.planSlug,
          status: 'active',
          provider: 'mercadopago',
          customerId: `mp_${reference.userId}`,
          subscriptionId: String(payment.id || dataId),
          currentPeriodStart: now.toISOString(),
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          createdAt: existing?.createdAt || now.toISOString(),
          updatedAt: now.toISOString(),
          priceBrl: plan.priceBrl,
          lastPaymentDate: now.toISOString(),
        });

        await subscriptionServerRepository.markWebhookCompleted(
          'mercadopago',
          eventId,
          eventType,
          'completed',
          { userId: reference.userId, paymentId: dataId, status: 'approved' },
        );

        return { processed: true, reason: 'PAYMENT_APPROVED', subscription };
      }

      if (payment.status === 'refunded' || payment.status === 'charged_back') {
        if (existing) {
          await subscriptionServerRepository.saveSubscription({
            ...existing,
            status: 'canceled',
            cancelAtPeriodEnd: true,
            updatedAt: now.toISOString(),
          });
        }
      }

      await subscriptionServerRepository.markWebhookCompleted(
        'mercadopago',
        eventId,
        eventType,
        'completed',
        { userId: reference.userId, paymentId: dataId, status: payment.status || 'unknown' },
      );

      return { processed: true, reason: `PAYMENT_${String(payment.status || 'UNKNOWN').toUpperCase()}` };
    } catch (error) {
      await subscriptionServerRepository.releaseWebhookClaim('mercadopago', eventId);
      throw error;
    }
  }
}

export const mercadoPagoWebhookService = new MercadoPagoWebhookService();
