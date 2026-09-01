import {
  PaymentProvider,
  CreatePaymentInput,
  PaymentTransactionResult,
  PaymentGatewayStatus,
} from './paymentProvider.interface';
import { logger } from '../../middlewares/logger';
import { paymentRepository, PersistedPayment } from '../../repositories/paymentRepository';
import { SERVER_CONFIG } from '../../config/env';

interface StripeCheckoutSession {
  id: string;
  url?: string | null;
  status?: 'open' | 'complete' | 'expired' | null;
  payment_status?: 'paid' | 'unpaid' | 'no_payment_required' | null;
  payment_intent?: string | null;
  customer?: string | null;
  subscription?: string | null;
}

interface StripeErrorResponse {
  error?: { message?: string; type?: string; code?: string };
}

export class StripeGatewayProvider implements PaymentProvider {
  public providerName = 'stripe';

  private get secretKey(): string {
    if (!SERVER_CONFIG.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY_NOT_CONFIGURED');
    }
    return SERVER_CONFIG.STRIPE_SECRET_KEY;
  }

  private async stripeRequest<T>(path: string, body?: URLSearchParams, idempotencyKey?: string): Promise<T> {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body?.toString(),
    });

    const payload = (await response.json()) as T & StripeErrorResponse;
    if (!response.ok) {
      const message = payload?.error?.message || `Stripe API request failed with status ${response.status}`;
      logger.error('Stripe API request failed', { path, status: response.status, message });
      throw new Error(`STRIPE_API_ERROR:${message}`);
    }

    return payload as T;
  }

  private getConfiguredPriceId(planSlug: CreatePaymentInput['planSlug']): string {
    const priceId = planSlug === 'PRO'
      ? SERVER_CONFIG.STRIPE_PRO_PRICE_ID
      : SERVER_CONFIG.STRIPE_APEX_ELITE_PRICE_ID;

    if (!priceId) throw new Error(`STRIPE_PRICE_ID_NOT_CONFIGURED:${planSlug}`);
    return priceId;
  }

  private getSuccessUrl(): string {
    if (!SERVER_CONFIG.STRIPE_SUCCESS_URL) throw new Error('STRIPE_SUCCESS_URL_NOT_CONFIGURED');
    return SERVER_CONFIG.STRIPE_SUCCESS_URL;
  }

  private getCancelUrl(): string {
    if (!SERVER_CONFIG.STRIPE_CANCEL_URL) throw new Error('STRIPE_CANCEL_URL_NOT_CONFIGURED');
    return SERVER_CONFIG.STRIPE_CANCEL_URL;
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentTransactionResult> {
    const existing = await paymentRepository.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const priceId = this.getConfiguredPriceId(input.planSlug);
    const params = new URLSearchParams();
    params.set('mode', 'subscription');
    params.set('success_url', this.getSuccessUrl());
    params.set('cancel_url', this.getCancelUrl());
    params.set('client_reference_id', input.userId);
    params.set('customer_email', input.userEmail);
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('metadata[user_id]', input.userId);
    params.set('metadata[plan_slug]', input.planSlug);
    params.set('metadata[idempotency_key]', input.idempotencyKey);

    // The same idempotency key is sent to Stripe and persisted locally. This
    // protects against the failure window where Stripe succeeds but Firestore
    // is temporarily unavailable before the transaction can be recorded.
    const session = await this.stripeRequest<StripeCheckoutSession>(
      'checkout/sessions',
      params,
      input.idempotencyKey
    );
    if (!session.id || !session.url) {
      throw new Error('STRIPE_INVALID_CHECKOUT_SESSION');
    }

    const now = new Date().toISOString();
    const payment: PersistedPayment = {
      transactionId: session.id,
      provider: this.providerName,
      status: 'pending',
      amountCents: input.amountCents,
      currency: 'BRL',
      paymentMethod: 'credit_card',
      checkoutUrl: session.url,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
      userId: input.userId,
      userEmail: input.userEmail,
      userName: input.userName,
      planSlug: input.planSlug,
    };

    const persisted = await paymentRepository.createIfAbsent(payment);
    logger.info(`Sessão Stripe Checkout real criada: ${persisted.transactionId}`);
    return persisted;
  }

  async getPaymentStatus(transactionId: string): Promise<PaymentGatewayStatus> {
    const local = await paymentRepository.findByTransactionId(transactionId);
    if (local && ['approved', 'failed', 'refunded', 'canceled'].includes(local.status)) {
      return local.status;
    }

    const session = await this.stripeRequest<StripeCheckoutSession>(`checkout/sessions/${encodeURIComponent(transactionId)}`);

    let status: PaymentGatewayStatus = 'pending';
    if (session.status === 'expired') status = 'expired';
    else if (session.status === 'complete' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')) status = 'approved';
    else if (session.status === 'complete' && session.payment_status === 'unpaid') status = 'pending';

    if (local && local.status !== status) {
      await paymentRepository.updateStatus(transactionId, status);
    }

    return status;
  }

  async cancelPayment(transactionId: string): Promise<boolean> {
    const session = await this.stripeRequest<StripeCheckoutSession>(`checkout/sessions/${encodeURIComponent(transactionId)}`);
    if (session.status === 'open') {
      const params = new URLSearchParams();
      await this.stripeRequest<StripeCheckoutSession>(`checkout/sessions/${encodeURIComponent(transactionId)}/expire`, params);
    }

    return (await paymentRepository.updateStatus(transactionId, 'canceled')) !== null;
  }

  async refundPayment(transactionId: string, amountCents?: number): Promise<boolean> {
    const session = await this.stripeRequest<StripeCheckoutSession>(`checkout/sessions/${encodeURIComponent(transactionId)}`);
    if (!session.payment_intent || typeof session.payment_intent !== 'string') {
      return false;
    }

    const params = new URLSearchParams();
    params.set('payment_intent', session.payment_intent);
    if (amountCents !== undefined) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) return false;
      params.set('amount', String(amountCents));
    }

    await this.stripeRequest('refunds', params);
    return (await paymentRepository.updateStatus(transactionId, 'refunded')) !== null;
  }
}
