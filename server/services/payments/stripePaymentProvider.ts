import {
  PaymentProvider,
  CreatePaymentInput,
  PaymentTransactionResult,
  PaymentGatewayStatus,
} from './paymentProvider.interface';
import { logger } from '../../middlewares/logger';
import { paymentRepository, PersistedPayment } from '../../repositories/paymentRepository';

export class StripeGatewayProvider implements PaymentProvider {
  public providerName = 'stripe';

  async createPayment(input: CreatePaymentInput): Promise<PaymentTransactionResult> {
    const existing = await paymentRepository.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const now = new Date().toISOString();
    const txId = `cs_stripe_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const result: PersistedPayment = {
      transactionId: txId,
      provider: this.providerName,
      status: 'pending',
      amountCents: input.amountCents,
      currency: 'BRL',
      paymentMethod: 'credit_card',
      checkoutUrl: `https://checkout.stripe.com/c/pay/${txId}`,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
      userId: input.userId,
      userEmail: input.userEmail,
      userName: input.userName,
      planSlug: input.planSlug,
    };

    const persisted = await paymentRepository.createIfAbsent(result);
    logger.info(`Sessão Stripe registrada de forma persistente: ${persisted.transactionId}`);
    return persisted;
  }

  async getPaymentStatus(transactionId: string): Promise<PaymentGatewayStatus> {
    const tx = await paymentRepository.findByTransactionId(transactionId);
    return tx ? tx.status : 'failed';
  }

  async updateStatusFromWebhook(transactionId: string, status: PaymentGatewayStatus): Promise<boolean> {
    const updated = await paymentRepository.updateStatus(transactionId, status);
    return updated !== null;
  }

  async cancelPayment(transactionId: string): Promise<boolean> {
    return (await paymentRepository.updateStatus(transactionId, 'canceled')) !== null;
  }

  async refundPayment(transactionId: string): Promise<boolean> {
    return (await paymentRepository.updateStatus(transactionId, 'refunded')) !== null;
  }
}
