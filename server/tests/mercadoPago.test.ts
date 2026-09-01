import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MercadoPagoPixProvider } from '../services/payments/mercadoPagoPixProvider';

const secret = 'test-mercado-pago-webhook-secret';
const dataId = '123456789';
const requestId = 'request-123';
const timestamp = Math.floor(Date.now() / 1000);
const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
const signature = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

const valid = MercadoPagoPixProvider.verifyWebhookSignature(
  `ts=${timestamp},v1=${signature}`,
  requestId,
  dataId,
  secret,
);
assert.equal(valid.valid, true);
assert.equal(valid.reason, 'VALID');

const tampered = MercadoPagoPixProvider.verifyWebhookSignature(
  `ts=${timestamp},v1=${'0'.repeat(64)}`,
  requestId,
  dataId,
  secret,
);
assert.equal(tampered.valid, false);
assert.equal(tampered.reason, 'INVALID_SIGNATURE');

const missing = MercadoPagoPixProvider.verifyWebhookSignature(
  undefined,
  requestId,
  dataId,
  secret,
);
assert.equal(missing.valid, false);
assert.equal(missing.reason, 'MISSING_SIGNATURE');

console.log('Mercado Pago webhook signature tests passed.');
