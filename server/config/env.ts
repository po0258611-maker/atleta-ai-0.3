import fs from 'fs';
import path from 'path';

const NODE_ENV = process.env.NODE_ENV?.trim() || 'development';
const isProduction = NODE_ENV === 'production';

const defaultOrigins = isProduction
  ? ['https://ai.studio', 'https://aistudio.google.com']
  : ['http://localhost:3000', 'https://ai.studio', 'https://aistudio.google.com'];
const corsOrigins = (process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : defaultOrigins)
  .map((s) => s.trim())
  .filter(Boolean);

const rawPaymentMode = process.env.PAYMENT_MODE?.trim().toLowerCase();
const paymentMode = rawPaymentMode === 'live' ? 'live' : 'mock';
const configuredPort = Number(process.env.PORT);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 ? configuredPort : 3000;

function resolveFirebaseProjectId(): string {
  try {
    const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed?.projectId && typeof parsed.projectId === 'string') {
        return parsed.projectId.trim();
      }
    }
  } catch {}

  const envProjectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (envProjectId && envProjectId !== 'localhost' && envProjectId !== 'storied-cable-xn50x') {
    return envProjectId;
  }

  return 'gen-lang-client-0402109874';
}

const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || '';
const pixWebhookSecret = process.env.PIX_WEBHOOK_SECRET?.trim() || '';

export const SERVER_CONFIG = {
  PORT: port,
  NODE_ENV,
  CORS_ORIGINS: corsOrigins,
  GEMINI_MODEL: process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY?.trim() || '',
  SUPABASE_URL: process.env.SUPABASE_URL?.trim() || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY?.trim() || '',
  FIREBASE_PROJECT_ID: resolveFirebaseProjectId(),
  PAYMENT_MODE: paymentMode,
  STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
  PIX_WEBHOOK_SECRET: pixWebhookSecret,
  TRUST_PROXY: process.env.TRUST_PROXY?.trim() === 'true',
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  RATE_LIMIT_MAX_REQUESTS: Math.max(1, Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 300),
  MAX_PROMPT_LENGTH: Math.max(100, Number(process.env.MAX_PROMPT_LENGTH) || 4000),
};

/**
 * Production-only fail-closed configuration guard.
 * Development/test environments may intentionally use mocks; production may not.
 */
export function validateProductionConfig(): void {
  if (!isProduction) return;

  const errors: string[] = [];

  if (SERVER_CONFIG.PAYMENT_MODE !== 'live') {
    errors.push('PAYMENT_MODE must be "live" in production; mock payment mode is forbidden.');
  }

  if (!SERVER_CONFIG.STRIPE_WEBHOOK_SECRET) {
    errors.push('STRIPE_WEBHOOK_SECRET must be configured in production.');
  }

  if (!SERVER_CONFIG.PIX_WEBHOOK_SECRET) {
    errors.push('PIX_WEBHOOK_SECRET must be configured in production.');
  }

  if (SERVER_CONFIG.CORS_ORIGINS.includes('*')) {
    errors.push('CORS_ORIGINS must not contain "*" in production.');
  }

  if (SERVER_CONFIG.FIREBASE_PROJECT_ID === 'gen-lang-client-0402109874') {
    errors.push('FIREBASE_PROJECT_ID must be explicitly configured for production.');
  }

  if (errors.length > 0) {
    throw new Error(`Production configuration rejected:\n- ${errors.join('\n- ')}`);
  }
}
