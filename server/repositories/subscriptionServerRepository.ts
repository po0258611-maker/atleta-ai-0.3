import {
  ServerSubscription,
  SubscriptionHistoryRecord,
  SubscriptionStatus,
  PaymentProvider,
} from '../domain/subscriptionModel';
import { getFirestoreAdapter, IFirestoreAdapter } from './firestoreAdapter';
import { logger } from '../middlewares/logger';

const STATUS_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(['pending', 'active', 'trialing', 'past_due', 'canceled', 'expired']),
  active: new Set(['active', 'past_due', 'canceled', 'expired', 'trialing']),
  trialing: new Set(['trialing', 'active', 'past_due', 'canceled', 'expired']),
  past_due: new Set(['past_due', 'active', 'canceled', 'expired']),
  canceled: new Set(['canceled', 'expired', 'active']),
  expired: new Set(['expired', 'active']),
};

function canTransition(from: SubscriptionStatus | undefined, to: SubscriptionStatus): boolean {
  if (!from) return true;
  return STATUS_TRANSITIONS[from]?.has(to) ?? false;
}

function historyEventFor(status: SubscriptionStatus, isNew: boolean): SubscriptionHistoryRecord['eventType'] {
  if (isNew) return 'CREATED';
  if (status === 'active' || status === 'trialing') return 'RENEWED';
  if (status === 'past_due') return 'PAYMENT_FAILED';
  if (status === 'canceled' || status === 'expired') return 'CANCELED';
  return 'PLAN_CHANGED';
}

export class SubscriptionServerRepository {
  private adapter?: IFirestoreAdapter;
  constructor(adapter?: IFirestoreAdapter) { this.adapter = adapter; }
  private get db(): IFirestoreAdapter { return this.adapter || getFirestoreAdapter(); }
  private get subscriptionsCol() { return this.db.collection('subscriptions'); }
  private get historyCol() { return this.db.collection('subscription_history'); }
  private get webhookEventsCol() { return this.db.collection('webhook_events'); }

  async findByUserId(userId: string): Promise<ServerSubscription | null> {
    const doc = await this.subscriptionsCol.doc(userId).get();
    return doc.exists ? (doc.data() as ServerSubscription) : null;
  }

  async findBySubscriptionId(subscriptionId: string): Promise<ServerSubscription | null> {
    const snapshot = await this.subscriptionsCol.where('subscriptionId', '==', subscriptionId).limit(1).get();
    return snapshot.empty ? null : snapshot.docs[0].data() as ServerSubscription;
  }

  async saveSubscription(sub: ServerSubscription): Promise<ServerSubscription> {
    const docRef = this.subscriptionsCol.doc(sub.userId);
    const existingSnap = await docRef.get();
    const existing = existingSnap.exists ? (existingSnap.data() as ServerSubscription) : null;
    const isNew = !existing;

    if (existing && existing.subscriptionId && sub.subscriptionId && existing.subscriptionId !== sub.subscriptionId) {
      throw new Error('SUBSCRIPTION_ID_MISMATCH');
    }
    if (!canTransition(existing?.status, sub.status)) {
      throw new Error(`INVALID_SUBSCRIPTION_TRANSITION:${existing?.status}->${sub.status}`);
    }

    const now = new Date().toISOString();
    const updatedSub: ServerSubscription = {
      ...existing,
      ...sub,
      userId: sub.userId,
      subscriptionId: sub.subscriptionId || existing?.subscriptionId || '',
      createdAt: existing?.createdAt || sub.createdAt || now,
      updatedAt: now,
    };

    if (updatedSub.status === 'canceled') {
      updatedSub.cancelAtPeriodEnd = sub.cancelAtPeriodEnd ?? existing?.cancelAtPeriodEnd ?? true;
      updatedSub.canceledAt = sub.canceledAt || existing?.canceledAt || now;
      updatedSub.autoRenew = false;
    }
    if (updatedSub.status === 'active' || updatedSub.status === 'trialing') {
      updatedSub.autoRenew = sub.autoRenew ?? existing?.autoRenew ?? !updatedSub.cancelAtPeriodEnd;
    }

    await docRef.set(updatedSub, { merge: true });

    if (isNew || existing?.status !== updatedSub.status || existing?.planId !== updatedSub.planId || existing?.currentPeriodEnd !== updatedSub.currentPeriodEnd) {
      const historyId = `hist_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const historyRecord: SubscriptionHistoryRecord = {
        id: historyId,
        subscriptionId: updatedSub.subscriptionId || updatedSub.id,
        userId: updatedSub.userId,
        eventType: historyEventFor(updatedSub.status, isNew),
        statusBefore: existing ? existing.status : 'pending',
        statusAfter: updatedSub.status,
        provider: updatedSub.provider,
        amountCents: Math.round(updatedSub.priceBrl * 100),
        timestamp: now,
      };
      await this.historyCol.doc(historyId).set(historyRecord);
    }
    return updatedSub;
  }

  async updateStatus(userId: string, newStatus: SubscriptionStatus, eventType: SubscriptionHistoryRecord['eventType'] = 'PLAN_CHANGED'): Promise<ServerSubscription | null> {
    const existing = await this.findByUserId(userId);
    if (!existing) return null;
    if (!canTransition(existing.status, newStatus)) throw new Error(`INVALID_SUBSCRIPTION_TRANSITION:${existing.status}->${newStatus}`);
    const now = new Date().toISOString();
    const updated = { ...existing, status: newStatus, updatedAt: now, autoRenew: newStatus === 'active' || newStatus === 'trialing' ? existing.autoRenew : false, cancelAtPeriodEnd: newStatus === 'canceled' ? true : existing.cancelAtPeriodEnd, canceledAt: newStatus === 'canceled' ? existing.canceledAt || now : existing.canceledAt };
    await this.subscriptionsCol.doc(userId).set(updated, { merge: true });
    const historyId = `hist_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await this.historyCol.doc(historyId).set({ id: historyId, subscriptionId: updated.subscriptionId || updated.id, userId, eventType, statusBefore: existing.status, statusAfter: newStatus, provider: updated.provider, amountCents: Math.round(updated.priceBrl * 100), timestamp: now });
    return updated;
  }

  async isWebhookProcessed(provider: PaymentProvider, eventId: string): Promise<boolean> {
    return (await this.webhookEventsCol.doc(`${provider}_${eventId}`).get()).exists;
  }

  async tryClaimWebhookEvent(provider: PaymentProvider, eventId: string, eventType = 'webhook') {
    const key = `${provider}_${eventId}`;
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get('webhook_events', key);
      if (snap.exists) return { claimed: false, alreadyProcessed: true };
      const nowIso = new Date().toISOString();
      tx.set('webhook_events', key, { provider, eventId, eventType, status: 'processing', receivedAt: nowIso, claimedAt: nowIso }, { merge: true });
      return { claimed: true, alreadyProcessed: false };
    });
  }

  async markWebhookProcessed(provider: PaymentProvider, eventId: string, eventType = 'webhook', status = 'processed'): Promise<void> {
    await this.webhookEventsCol.doc(`${provider}_${eventId}`).set({ provider, eventId, eventType, status, processedAt: new Date().toISOString() }, { merge: true });
  }

  async markWebhookCompleted(provider: PaymentProvider, eventId: string, eventType = 'webhook', status = 'completed', metadata?: Record<string, any>): Promise<void> {
    await this.webhookEventsCol.doc(`${provider}_${eventId}`).set({ provider, eventId, eventType, status, processedAt: new Date().toISOString(), ...metadata }, { merge: true });
  }

  async releaseWebhookClaim(provider: PaymentProvider, eventId: string): Promise<void> {
    await this.webhookEventsCol.doc(`${provider}_${eventId}`).delete();
  }

  async getHistoryByUserId(userId: string): Promise<SubscriptionHistoryRecord[]> {
    const snapshot = await this.historyCol.where('userId', '==', userId).get();
    return snapshot.docs.map((doc) => doc.data() as SubscriptionHistoryRecord).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }
}

export const subscriptionServerRepository = new SubscriptionServerRepository();
