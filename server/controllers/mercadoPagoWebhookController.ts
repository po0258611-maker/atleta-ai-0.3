import type { Request, Response } from 'express';
import { mercadoPagoWebhookService } from '../services/mercadoPagoWebhookService';
import { logger } from '../middlewares/logger';

export async function handleMercadoPagoWebhook(req: Request, res: Response) {
  const dataId = typeof req.query['data.id'] === 'string' ? req.query['data.id'] : undefined;
  const xSignature = typeof req.headers['x-signature'] === 'string' ? req.headers['x-signature'] : undefined;
  const xRequestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined;

  if (!dataId) {
    return res.status(400).json({ error: { code: 'MISSING_DATA_ID', message: 'Identificador do pagamento ausente.' } });
  }

  try {
    const result = await mercadoPagoWebhookService.handle(req.body ?? {}, dataId, xSignature, xRequestId);
    return res.status(200).json({ status: 'ok', result });
  } catch (error: any) {
    const message = String(error?.message || 'MERCADOPAGO_WEBHOOK_ERROR');
    const unauthorized = message.includes('MISSING_') || message.includes('INVALID_SIGNATURE') || message.includes('INVALID_TIMESTAMP');
    logger.warn('Mercado Pago webhook processing failed', { reason: message, dataId });
    return res.status(unauthorized ? 401 : 500).json({
      error: {
        code: unauthorized ? 'WEBHOOK_AUTHENTICATION_FAILED' : 'WEBHOOK_PROCESSING_ERROR',
        message: unauthorized ? 'Webhook não autenticado.' : 'Não foi possível processar a notificação.',
      },
    });
  }
}
