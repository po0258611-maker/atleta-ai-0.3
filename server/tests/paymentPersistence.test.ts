import { MemoryFirestoreAdapter, setFirestoreAdapter } from '../repositories/firestoreAdapter';
import { PixPaymentProvider } from '../services/payments/pixPaymentProvider';
import { StripeGatewayProvider } from '../services/payments/stripePaymentProvider';

async function runPaymentPersistenceTests() {
  setFirestoreAdapter(new MemoryFirestoreAdapter());

  const input = {
    userId: 'persistence-test-user',
    userEmail: 'persistence@example.com',
    userName: 'Persistence Test',
    planSlug: 'PRO' as const,
    amountCents: 1500,
    paymentMethod: 'credit_card' as const,
    idempotencyKey: `persist_${Date.now()}`,
  };

  const firstProvider = new StripeGatewayProvider();
  const first = await firstProvider.createPayment(input);

  const secondProvider = new StripeGatewayProvider();
  const recovered = await secondProvider.createPayment(input);
  if (recovered.transactionId !== first.transactionId) {
    throw new Error('Persistent idempotency failed: a new provider instance created a duplicate transaction.');
  }

  const recoveredStatus = await secondProvider.getPaymentStatus(first.transactionId);
  if (recoveredStatus !== 'pending') {
    throw new Error(`Persistent status failed: expected pending, got ${recoveredStatus}.`);
  }

  const updated = await secondProvider.updateStatusFromWebhook(first.transactionId, 'approved');
  if (!updated) throw new Error('Persistent status update failed.');

  const thirdProvider = new StripeGatewayProvider();
  const persistedStatus = await thirdProvider.getPaymentStatus(first.transactionId);
  if (persistedStatus !== 'approved') {
    throw new Error(`Persistent status recovery failed: expected approved, got ${persistedStatus}.`);
  }

  const pixInput = { ...input, paymentMethod: 'pix' as const, idempotencyKey: `pix_persist_${Date.now()}` };
  const pixFirst = await new PixPaymentProvider().createPayment(pixInput);
  const pixSecond = await new PixPaymentProvider().createPayment(pixInput);
  if (pixSecond.transactionId !== pixFirst.transactionId) {
    throw new Error('PIX persistent idempotency failed across provider instances.');
  }

  console.log('✓ Payment persistence: transaction, idempotency and status survive provider re-instantiation.');
}

runPaymentPersistenceTests().catch((err) => {
  console.error('Payment persistence tests failed:', err);
  process.exit(1);
});
