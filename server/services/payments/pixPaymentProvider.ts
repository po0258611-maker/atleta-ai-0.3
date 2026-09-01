import {
  PaymentProvider,
  CreatePaymentInput,
  PaymentTransactionResult,
  PaymentGatewayStatus,
} from './paymentProvider.interface';
import { logger } from '../../middlewares/logger';
import { paymentRepository, PersistedPayment } from '../../repositories/paymentRepository';

export class PixPaymentProvider implements PaymentProvider {
  public providerName = 'pix_direct';

  async createPayment(input: CreatePaymentInput): Promise<PaymentTransactionResult> {
    const existing = await paymentRepository.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      logger.info(`Transação Pix recuperada do armazenamento persistente: ${input.idempotencyKey}`);
      return existing;
    }

    const txId = `pix_${Date.now()}_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const amountFormatted = (input.amountCents / 100).toFixed(2);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // This remains the existing simulated EMV payload until a real PSP is integrated.
    const copiaECola = `00020126580014br.gov.bcb.pix0136athleta.ai.pagamentos@gmail.com5204000053039865405${amountFormatted}5802BR5910ATHLETA AI6009SAO PAULO62070503***6304${txId.substring(0, 8)}`;
    const qrCodeUrl = `https://quickchart.io/qr?text=${encodeURIComponent(copiaECola)}&size=250&margin=1`;

    const result: PersistedPayment = {
      transactionId: txId,
      provider: this.providerName,
      status: 'pending',
      amountCents: input.amountCents,
      currency: 'BRL',
      paymentMethod: 'pix',
      copiaECola,
      qrCodeUrl,
      expiresAt,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
      userId: input.userId,
      userEmail: input.userEmail,
      userName: input.userName,
      planSlug: input.planSlug,
    };

    const persisted = await paymentRepository.createIfAbsent(result);
    logger.info(`Ordem PIX persistida: ${persisted.transactionId} | Valor: R$ ${amountFormatted} | Status: PENDING`);
    return persisted;
  }

  async getPaymentStatus(transactionId: string): Promise<PaymentGatewayStatus> {
    const tx = await paymentRepository.findByTransactionId(transactionId);
    if (!tx) return 'failed';

    if (tx.status === 'pending' && tx.expiresAt && new Date(tx.expiresAt).getTime() < Date.now()) {
      await paymentRepository.updateStatus(transactionId, 'expired');
      return 'expired';
    }

    return tx.status;
  }

  async approvePaymentFromWebhook(transactionId: string): Promise<boolean> {
    const updated = await paymentRepository.updateStatus(transactionId, 'approved');
    if (!updated) return false;
    logger.info(`PIX liquidado e aprovado via webhook bancário: ${transactionId}`);
    return true;
  }

  async cancelPayment(transactionId: string): Promise<boolean> {
    return (await paymentRepository.updateStatus(transactionId, 'canceled')) !== null;
  }

  async refundPayment(transactionId: string): Promise<boolean> {
    return (await paymentRepository.updateStatus(transactionId, 'refunded')) !== null;
  }
}
