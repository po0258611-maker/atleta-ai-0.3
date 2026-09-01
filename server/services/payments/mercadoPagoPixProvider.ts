import crypto from 'crypto';
import {
  PaymentProvider,
  CreatePaymentInput,
  PaymentTransactionResult,
  PaymentGatewayStatus,
} from './paymentProvider.interface';
import { SERVER_CONFIG } from '../../config/env';
import { logger } from '../../middlewares/logger';

const MERCADO_PAGO_API = 'https://api.mercadopago.com';

type MercadoPagoPayment = {
  id?: number | string;
  status?: string;
  status_detail?: string;
  transaction_amount?: number;
  external_reference?: string;
  date_of_expiration?: string;
  point_of_interaction?: {
    transaction_data?: {
      qr_code?: string;
      qr_code_base64?: string;
      ticket_url?: string;
    };
  };
};

function mapStatus(status?: string): PaymentGatewayStatus {
  switch (status) {
    case 'approved': return 'approved';
    case 'rejected': return 'failed';
    case 'cancelled':
    case 'canceled': return 'canceled';
    case 'refunded':
    case 'charged_back': return 'refunded';
    case 'expired': return 'expired';
    default: return 'pending';
  }
}

export interface MercadoPagoWebhookVerification {
  valid: boolean;
  reason: 'VALID' | 'MISSING_SIGNATURE' | 'MISSING_REQUEST_ID' | 'MISSING_DATA_ID' | 'MISSING_SECRET' | 'INVALID_SIGNATURE' | 'INVALID_TIMESTAMP';
}

export class MercadoPagoPixProvider implements PaymentProvider {
  public providerName = 'mercadopago';

  private get accessToken(): string {
    const token = SERVER_CONFIG.MERCADOPAGO_ACCESS_TOKEN?.trim();
    if (!token) throw new Error('MERCADOPAGO_ACCESS_TOKEN_NOT_CONFIGURED');
    return token;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${MERCADO_PAGO_API}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
        ...(init.headers || {}),
      },
    });

    const text = await response.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text };
    }

    if (!response.ok) {
      const message = typeof body === 'object' && body && 'message' in body
        ? String((body as { message?: unknown }).message)
        : `HTTP_${response.status}`;
      logger.error('Mercado Pago API request failed', { path, status: response.status, message });
      throw new Error(`MERCADOPAGO_API_ERROR:${response.status}`);
    }

    return body as T;
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentTransactionResult> {
    if (input.paymentMethod !== 'pix') throw new Error('PAYMENT_METHOD_NOT_SUPPORTED');

    const amount = Number((input.amountCents / 100).toFixed(2));
    const externalReference = Buffer.from(
      JSON.stringify({ userId: input.userId, planSlug: input.planSlug }),
      'utf8'
    ).toString('base64url');

    const body: Record<string, unknown> = {
      transaction_amount: amount,
      description: `ATHLETA AI - Plano ${input.planSlug}`,
      payment_method_id: 'pix',
      payer: { email: input.userEmail },
      external_reference: externalReference,
      metadata: { athlete_user_id: input.userId, plan_slug: input.planSlug },
    };

    if (SERVER_CONFIG.MERCADOPAGO_NOTIFICATION_URL) {
      body.notification_url = SERVER_CONFIG.MERCADOPAGO_NOTIFICATION_URL;
    }

    const payment = await this.request<MercadoPagoPayment>('/v1/payments', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(body),
    });

    if (!payment.id) throw new Error('MERCADOPAGO_INVALID_RESPONSE');

    const transactionData = payment.point_of_interaction?.transaction_data;
    const qrCodeUrl = transactionData?.qr_code_base64
      ? `data:image/png;base64,${transactionData.qr_code_base64}`
      : transactionData?.ticket_url;

    return {
      transactionId: String(payment.id),
      provider: this.providerName,
      status: mapStatus(payment.status),
      amountCents: Math.round(Number(payment.transaction_amount ?? amount) * 100),
      currency: 'BRL',
      paymentMethod: 'pix',
      qrCodeUrl,
      copiaECola: transactionData?.qr_code,
      expiresAt: payment.date_of_expiration,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString(),
    };
  }

  async getPaymentStatus(transactionId: string): Promise<PaymentGatewayStatus> {
    const payment = await this.request<MercadoPagoPayment>(`/v1/payments/${encodeURIComponent(transactionId)}`, { method: 'GET' });
    return mapStatus(payment.status);
  }

  async cancelPayment(_transactionId: string): Promise<boolean> {
    return false;
  }

  async refundPayment(transactionId: string, amountCents?: number): Promise<boolean> {
    const body = amountCents === undefined ? undefined : JSON.stringify({ amount: amountCents / 100 });
    await this.request(`/v1/payments/${encodeURIComponent(transactionId)}/refunds`, {
      method: 'POST',
      headers: { 'X-Idempotency-Key': crypto.randomUUID() },
      body,
    });
    return true;
  }

  static verifyWebhookSignature(
    xSignature: string | undefined,
    xRequestId: string | undefined,
    dataId: string | undefined,
    secret: string | undefined,
    toleranceSeconds = 300,
  ): MercadoPagoWebhookVerification {
    if (!xSignature) return { valid: false, reason: 'MISSING_SIGNATURE' };
    if (!xRequestId) return { valid: false, reason: 'MISSING_REQUEST_ID' };
    if (!dataId) return { valid: false, reason: 'MISSING_DATA_ID' };
    if (!secret?.trim()) return { valid: false, reason: 'MISSING_SECRET' };

    let timestamp = '';
    let signature = '';
    for (const part of xSignature.split(',')) {
      const [key, ...rest] = part.trim().split('=');
      const value = rest.join('=').trim();
      if (key === 'ts') timestamp = value;
      if (key === 'v1') signature = value;
    }

    const tsNumber = Number(timestamp);
    if (!Number.isFinite(tsNumber) || tsNumber <= 0) return { valid: false, reason: 'INVALID_TIMESTAMP' };

    const now = Math.floor(Date.now() / 1000);
    const normalizedTs = tsNumber > 1_000_000_000_000 ? Math.floor(tsNumber / 1000) : tsNumber;
    if (Math.abs(now - normalizedTs) > toleranceSeconds) return { valid: false, reason: 'INVALID_TIMESTAMP' };

    const manifest = `id:${dataId};request-id:${xRequestId};ts:${timestamp};`;
    const expected = crypto.createHmac('sha256', secret).update(manifest, 'utf8').digest('hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    const receivedBuffer = Buffer.from(signature, 'hex');

    if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    return { valid: true, reason: 'VALID' };
  }

  async getPayment(transactionId: string): Promise<MercadoPagoPayment> {
    return this.request<MercadoPagoPayment>(`/v1/payments/${encodeURIComponent(transactionId)}`, { method: 'GET' });
  }
}
