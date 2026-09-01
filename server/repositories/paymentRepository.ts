import { getFirestoreAdapter } from './firestoreAdapter';
import { PaymentGatewayStatus, PaymentTransactionResult } from '../services/payments/paymentProvider.interface';

export interface PersistedPayment extends PaymentTransactionResult {
  userId: string;
  userEmail: string;
  userName: string;
  planSlug: 'PRO' | 'APEX_ELITE';
  updatedAt: string;
}

const COLLECTION = 'payments';

function docIdForTransaction(transactionId: string): string {
  return transactionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class PaymentRepository {
  async createIfAbsent(payment: PersistedPayment): Promise<PersistedPayment> {
    const adapter = getFirestoreAdapter();
    return adapter.runTransaction(async (tx) => {
      const idempotencyDocId = `idempotency_${docIdForTransaction(payment.idempotencyKey)}`;
      const existing = await tx.get(COLLECTION, idempotencyDocId);

      if (existing.exists) {
        return existing.data() as PersistedPayment;
      }

      const transactionDocId = docIdForTransaction(payment.transactionId);
      const payload = { ...payment };
      tx.set(COLLECTION, transactionDocId, payload);
      tx.set(COLLECTION, idempotencyDocId, {
        transactionId: payment.transactionId,
        provider: payment.provider,
        idempotencyKey: payment.idempotencyKey,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      });
      return payment;
    });
  }

  async findByTransactionId(transactionId: string): Promise<PersistedPayment | null> {
    const snapshot = await getFirestoreAdapter()
      .collection(COLLECTION)
      .doc(docIdForTransaction(transactionId))
      .get();
    return snapshot.exists ? (snapshot.data() as PersistedPayment) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PersistedPayment | null> {
    const snapshot = await getFirestoreAdapter()
      .collection(COLLECTION)
      .doc(`idempotency_${docIdForTransaction(idempotencyKey)}`)
      .get();
    if (!snapshot.exists) return null;

    const index = snapshot.data() as { transactionId: string };
    return this.findByTransactionId(index.transactionId);
  }

  async updateStatus(transactionId: string, status: PaymentGatewayStatus): Promise<PersistedPayment | null> {
    const payment = await this.findByTransactionId(transactionId);
    if (!payment) return null;

    const updated: PersistedPayment = {
      ...payment,
      status,
      updatedAt: new Date().toISOString(),
    };
    await getFirestoreAdapter()
      .collection(COLLECTION)
      .doc(docIdForTransaction(transactionId))
      .set(updated);
    return updated;
  }
}

export const paymentRepository = new PaymentRepository();
