/**
 * Deterministic tests for the live Stripe provider HTTP boundary.
 * No real Stripe credentials or network calls are used.
 */

process.env.NODE_ENV = 'test';
process.env.PAYMENT_MODE = 'live';
process.env.STRIPE_SECRET_KEY = 'sk_test_unit_test_key';
process.env.STRIPE_PRO_PRICE_ID = 'price_test_pro';
process.env.STRIPE_APEX_ELITE_PRICE_ID = 'price_test_apex';
process.env.STRIPE_SUCCESS_URL = 'https://example.com/success';
process.env.STRIPE_CANCEL_URL = 'https://example.com/cancel';

import { setFirestoreAdapter, MemoryFirestoreAdapter } from '../repositories/firestoreAdapter';

setFirestoreAdapter(new MemoryFirestoreAdapter());

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; method: string; body?: string }> = [];

(globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, method: init?.method || 'GET', body: typeof init?.body === 'string' ? init.body : undefined });

  if (url.endsWith('/v1/checkout/sessions') && init?.method === 'POST') {
    return new Response(JSON.stringify({
      id: 'cs_test_live_provider_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_live_provider_123',
      status: 'open',
      payment_status: 'unpaid',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (url.endsWith('/v1/checkout/sessions/cs_test_live_provider_123') && init?.method === 'GET') {
    return new Response(JSON.stringify({
      id: 'cs_test_live_provider_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_live_provider_123',
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_test_123',
      customer: 'cus_test_123',
      subscription: 'sub_test_123',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  throw new Error(`Unexpected Stripe test request: ${url}`);
};

async function run() {
  try {
    const { StripeGatewayProvider } = await import('../services/payments/stripePaymentProvider');
    const { paymentRepository } = await import('../repositories/paymentRepository');

    const provider = new StripeGatewayProvider();
    const key = `stripe_live_unit_${Date.now()}`;

    const result = await provider.createPayment({
      userId: 'user_test_123',
      userEmail: 'teste@example.com',
      userName: 'Atleta Teste',
      planSlug: 'PRO',
      amountCents: 1500,
      paymentMethod: 'credit_card',
      idempotencyKey: key,
    });

    console.assert(result.transactionId === 'cs_test_live_provider_123', 'Deve persistir o ID real da Checkout Session');
    console.assert(result.checkoutUrl === 'https://checkout.stripe.com/c/pay/cs_test_live_provider_123', 'Deve retornar a URL fornecida pelo Stripe');
    console.assert(result.status === 'pending', 'Checkout criado deve iniciar como PENDING');

    const persisted = await paymentRepository.findByIdempotencyKey(key);
    console.assert(persisted?.transactionId === result.transactionId, 'Pagamento deve permanecer persistido');

    const status = await provider.getPaymentStatus(result.transactionId);
    console.assert(status === 'approved', 'Sessão concluída e paga deve resultar em APPROVED');

    console.assert(requests.some((request) => request.url.endsWith('/v1/checkout/sessions') && request.method === 'POST'), 'Deve chamar a API de Checkout Sessions');
    console.log('✓ Stripe live provider: Checkout Session + persistência + status');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

run().catch((error) => {
  console.error('Falha no teste Stripe live provider:', error);
  process.exit(1);
});
