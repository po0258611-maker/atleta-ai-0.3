import type { Request, Response } from 'express';
import { stripeWebhookService } from '../services/stripeWebhookService';
import { logger } from '../middlewares/logger';

export async function handleStripeWebhook(req: Request, res: Response) {
  const signature = req.headers['stripe-signature'];
  const signatureHeader = Array.isArray(signature) ? signature[0] : signature;
  const rawPayload = (req as any).rawBody;

  if (typeof rawPayload !== 'string' || !rawPayload) {
    return res.status(400).json({
      error: { code: 'MISSING_RAW_PAYLOAD', message: 'Payload bruto do Stripe não está disponível.' },
    });
  }

  try {
    const result = await stripeWebhookService.handle(rawPayload, signatureHeader);

    if (!result.processed) {
      const authReasons = new Set([
        'MISSING_SIGNATURE',
        'MISSING_SECRET',
        'INVALID_HEADER_FORMAT',
        'INVALID_SIGNATURE_MISMATCH',
        'REPLAY_ATTACK_TIMESTAMP_EXPIRED',
        'TIMESTAMP_IN_FUTURE',
      ]);

      if (authReasons.has(result.reason)) {
        return res.status(401).json({ error: { code: result.reason, message: 'Falha na autenticação do webhook Stripe.' } });
      }

      if (result.reason === 'USER_NOT_FOUND') {
        return res.status(404).json({ error: { code: result.reason, message: 'Não foi possível associar o evento Stripe a um usuário.' } });
      }

      if (['INVALID_AMOUNT', 'INVALID_CURRENCY', 'INVALID_STRIPE_PRICE', 'PAYMENT_NOT_SETTLED'].includes(result.reason)) {
        return res.status(400).json({ error: { code: result.reason, message: 'Evento Stripe rejeitado por validação financeira.' } });
      }

      return res.status(400).json({ error: { code: result.reason, message: 'Evento Stripe inválido.' } });
    }

    return res.status(200).json({ status: 'ok', result });
  } catch (error: any) {
    logger.error('Stripe webhook processing failed', { error: error?.message || error });
    return res.status(500).json({ error: { code: 'STRIPE_WEBHOOK_PROCESSING_ERROR', message: 'Falha temporária no processamento do webhook.' } });
  }
}
