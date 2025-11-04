import { trace, SpanStatusCode } from '@opentelemetry/api';

/**
 * Credits Service - Atomic credit management with Redis caching and Firestore persistence
 * 
 * Features:
 * - Atomic credit deduction using Redis
 * - Daily free tier enforcement (2-3 per day)
 * - Credit balance caching with TTL
 * - Firestore ledger for audit and Stripe sync
 * - Refund logic for failed operations
 */

const DEFAULT_DAILY_FREE_LIMIT = 3;
const CACHE_TTL_SECONDS = 60; // 1 minute cache
const FREE_TIER_RESET_HOUR = 0; // Reset at midnight UTC

export class CreditsService {
  constructor({ redisClient, firestoreClient, logger } = {}) {
    if (!redisClient) {
      throw new Error('CreditsService requires a redisClient');
    }
    if (!firestoreClient) {
      throw new Error('CreditsService requires a firestoreClient');
    }
    
    this.redis = redisClient;
    this.firestore = firestoreClient;
    this.logger = logger ?? console;
  }

  /**
   * Check user entitlement and atomically deduct credits if available
   * @param {string} userId - User identifier
   * @param {number} amount - Credits to deduct (default: 1)
   * @param {string} jobId - Job identifier for ledger tracking
   * @returns {Promise<Object>} Result with allowed status and remaining credits
   */
  async checkAndDeduct({ userId, amount = 1, jobId }) {
    const tracer = trace.getTracer('credits');
    const span = tracer.startSpan('credits.checkAndDeduct', {
      attributes: {
        'credits.user_id': userId,
        'credits.amount': amount,
        'credits.job_id': jobId || 'unknown'
      }
    });

    try {
      this.logger.debug('[credits] Checking and deducting credits', {
        userId,
        amount,
        jobId
      });

      // First check daily free tier
      const freeUsage = await this._checkDailyFreeUsage(userId);
      const dailyLimit = this._getDailyFreeLimit(userId);
      
      if (freeUsage.used < dailyLimit) {
        // User has free credits available
        const success = await this._consumeFreeCredit(userId, jobId);
        if (success) {
          span.setAttributes({
            'credits.type': 'free',
            'credits.daily_used': freeUsage.used + 1,
            'credits.daily_remaining': dailyLimit - freeUsage.used - 1
          });

          this.logger.info('[credits] Free credit consumed', {
            userId,
            jobId,
            dailyUsed: freeUsage.used + 1,
            dailyRemaining: dailyLimit - freeUsage.used - 1
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return {
            allowed: true,
            type: 'free',
            remainingCredits: dailyLimit - freeUsage.used - 1,
            dailyFreeUsed: freeUsage.used + 1,
            dailyFreeLimit: dailyLimit
          };
        }
      }

      // Check paid credits
      const paidResult = await this._checkAndDeductPaidCredits(userId, amount, jobId);
      
      span.setAttributes({
        'credits.type': 'paid',
        'credits.remaining': paidResult.remainingCredits,
        'credits.allowed': paidResult.allowed
      });

      if (paidResult.allowed) {
        this.logger.info('[credits] Paid credit consumed', {
          userId,
          jobId,
          amount,
          remaining: paidResult.remainingCredits
        });
      } else {
        this.logger.warn('[credits] Insufficient credits', {
          userId,
          jobId,
          requested: amount,
          available: paidResult.remainingCredits
        });
      }

      span.setStatus({ code: SpanStatusCode.OK });
      return {
        ...paidResult,
        type: 'paid',
        dailyFreeUsed: freeUsage.used,
        dailyFreeLimit: dailyLimit
      };

    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      this.logger.error('[credits] Credit check failed', {
        userId,
        amount,
        jobId,
        error: error.message
      });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Refund credits for failed operations
   * @param {string} userId - User identifier
   * @param {string} jobId - Job identifier
   * @param {number} amount - Credits to refund
   * @param {string} reason - Refund reason
   * @returns {Promise<Object>} Refund result
   */
  async refund({ userId, jobId, amount = 1, reason = 'Job failed' }) {
    const tracer = trace.getTracer('credits');
    const span = tracer.startSpan('credits.refund', {
      attributes: {
        'credits.user_id': userId,
        'credits.job_id': jobId,
        'credits.amount': amount,
        'credits.reason': reason
      }
    });

    try {
      this.logger.info('[credits] Processing refund', {
        userId,
        jobId,
        amount,
        reason
      });

      // Check if this was a free credit or paid credit from the ledger
      const originalTransaction = await this._getTransactionByJobId(jobId);
      
      if (!originalTransaction) {
        this.logger.warn('[credits] No original transaction found for refund', { userId, jobId });
        return { success: false, reason: 'Original transaction not found' };
      }

      let refundResult;
      
      if (originalTransaction.type === 'free') {
        refundResult = await this._refundFreeCredit(userId, jobId);
      } else {
        refundResult = await this._refundPaidCredits(userId, amount, jobId, reason);
      }

      // Record refund in ledger
      await this._recordTransaction({
        userId,
        jobId,
        amount: amount,
        type: 'refund',
        reason,
        originalTransactionId: originalTransaction.id
      });

      span.setAttributes({
        'credits.refund_success': refundResult.success,
        'credits.refund_type': originalTransaction.type
      });

      this.logger.info('[credits] Refund completed', {
        userId,
        jobId,
        amount,
        success: refundResult.success,
        type: originalTransaction.type
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return refundResult;

    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      this.logger.error('[credits] Refund failed', {
        userId,
        jobId,
        amount,
        error: error.message
      });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Get user's current credit balance and usage
   * @param {string} userId - User identifier
   * @returns {Promise<Object>} Credit balance information
   */
  async getBalance(userId) {
    const tracer = trace.getTracer('credits');
    const span = tracer.startSpan('credits.getBalance', {
      attributes: { 'credits.user_id': userId }
    });

    try {
      const [paidCredits, freeUsage] = await Promise.all([
        this._getPaidCredits(userId),
        this._checkDailyFreeUsage(userId)
      ]);

      const dailyLimit = this._getDailyFreeLimit(userId);
      const freeRemaining = Math.max(0, dailyLimit - freeUsage.used);

      const balance = {
        paidCredits,
        freeCredits: freeRemaining,
        dailyFreeUsed: freeUsage.used,
        dailyFreeLimit: dailyLimit,
        totalAvailable: paidCredits + freeRemaining
      };

      span.setAttributes({
        'credits.paid': paidCredits,
        'credits.free_remaining': freeRemaining,
        'credits.total': balance.totalAvailable
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return balance;

    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  }

  // Private methods for credit management

  async _checkDailyFreeUsage(userId) {
    const today = this._getTodayKey();
    const key = `free_usage:${userId}:${today}`;
    
    try {
      const used = await this.redis.get(key);
      return {
        used: parseInt(used) || 0,
        date: today
      };
    } catch (error) {
      this.logger.warn('[credits] Failed to check daily free usage, assuming 0', { userId, error: error.message });
      return { used: 0, date: today };
    }
  }

  async _consumeFreeCredit(userId, jobId) {
    const today = this._getTodayKey();
    const key = `free_usage:${userId}:${today}`;
    const dailyLimit = this._getDailyFreeLimit(userId);
    
    try {
      // Atomic increment with limit check
      const script = `
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local current = redis.call('GET', key) or 0
        current = tonumber(current)
        
        if current >= limit then
          return 0
        end
        
        local new_value = redis.call('INCR', key)
        redis.call('EXPIRE', key, 86400)
        return new_value
      `;

      const result = await this.redis.eval(script, {
        keys: [key],
        arguments: [dailyLimit.toString()]
      });

      if (result > 0) {
        // Record in ledger
        await this._recordTransaction({
          userId,
          jobId,
          amount: -1,
          type: 'free',
          reason: 'Daily free credit consumed'
        });
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.error('[credits] Failed to consume free credit', { userId, jobId, error: error.message });
      return false;
    }
  }

  async _checkAndDeductPaidCredits(userId, amount, jobId) {
    const cacheKey = `credits:${userId}`;
    
    try {
      // Try to get from cache first
      let balance = await this.redis.get(cacheKey);
      
      if (balance === null) {
        // Cache miss: load from Firestore
        balance = await this._loadCreditsFromFirestore(userId);
        await this.redis.set(cacheKey, balance.toString(), { EX: CACHE_TTL_SECONDS });
      } else {
        balance = parseInt(balance);
      }

      // Atomic decrement with check
      const script = `
        local key = KEYS[1]
        local amount = tonumber(ARGV[1])
        local current = tonumber(redis.call('GET', key) or 0)
        
        if current < amount then
          return {0, current}
        end
        
        local new_balance = current - amount
        redis.call('SET', key, new_balance)
        redis.call('EXPIRE', key, ${CACHE_TTL_SECONDS})
        return {1, new_balance}
      `;

      const result = await this.redis.eval(script, {
        keys: [cacheKey],
        arguments: [amount.toString()]
      });

      const [success, newBalance] = result;
      
      if (success === 1) {
        // Async sync to Firestore
        this._syncCreditsToFirestore(userId, newBalance).catch(error => {
          this.logger.error('[credits] Failed to sync to Firestore', { userId, error: error.message });
        });

        // Record in ledger
        await this._recordTransaction({
          userId,
          jobId,
          amount: -amount,
          type: 'paid',
          reason: 'Credit consumed for job'
        });

        return { allowed: true, remainingCredits: newBalance };
      }

      return { allowed: false, remainingCredits: newBalance };

    } catch (error) {
      this.logger.error('[credits] Paid credit check failed', { userId, amount, error: error.message });
      throw error;
    }
  }

  async _refundFreeCredit(userId, jobId) {
    const today = this._getTodayKey();
    const key = `free_usage:${userId}:${today}`;
    
    try {
      const current = await this.redis.get(key);
      if (current && parseInt(current) > 0) {
        await this.redis.decr(key);
        return { success: true, type: 'free' };
      }
      return { success: false, reason: 'No free credits to refund' };
    } catch (error) {
      this.logger.error('[credits] Free credit refund failed', { userId, jobId, error: error.message });
      return { success: false, reason: error.message };
    }
  }

  async _refundPaidCredits(userId, amount, jobId, reason) {
    const cacheKey = `credits:${userId}`;
    
    try {
      // Atomic increment
      const newBalance = await this.redis.incrBy(cacheKey, amount);
      await this.redis.expire(cacheKey, CACHE_TTL_SECONDS);

      // Async sync to Firestore
      this._syncCreditsToFirestore(userId, newBalance).catch(error => {
        this.logger.error('[credits] Failed to sync refund to Firestore', { userId, error: error.message });
      });

      return { success: true, newBalance, type: 'paid' };
    } catch (error) {
      this.logger.error('[credits] Paid credit refund failed', { userId, amount, error: error.message });
      throw error;
    }
  }

  async _getPaidCredits(userId) {
    const cacheKey = `credits:${userId}`;
    
    try {
      let balance = await this.redis.get(cacheKey);
      
      if (balance === null) {
        balance = await this._loadCreditsFromFirestore(userId);
        await this.redis.set(cacheKey, balance.toString(), { EX: CACHE_TTL_SECONDS });
      }
      
      return parseInt(balance) || 0;
    } catch (error) {
      this.logger.warn('[credits] Failed to get paid credits, assuming 0', { userId, error: error.message });
      return 0;
    }
  }

  async _loadCreditsFromFirestore(userId) {
    try {
      const doc = await this.firestore.collection('users').doc(userId).get();
      return doc.exists ? (doc.data().credits || 0) : 0;
    } catch (error) {
      this.logger.error('[credits] Failed to load from Firestore', { userId, error: error.message });
      return 0;
    }
  }

  async _syncCreditsToFirestore(userId, balance) {
    try {
      await this.firestore.collection('users').doc(userId).set({
        credits: balance,
        lastUpdated: new Date()
      }, { merge: true });
    } catch (error) {
      this.logger.error('[credits] Firestore sync failed', { userId, balance, error: error.message });
      throw error;
    }
  }

  async _recordTransaction({ userId, jobId, amount, type, reason, originalTransactionId }) {
    try {
      const transaction = {
        userId,
        jobId,
        amount,
        type,
        reason,
        timestamp: new Date(),
        originalTransactionId: originalTransactionId || null
      };

      await this.firestore.collection('credit_ledger').add(transaction);
    } catch (error) {
      this.logger.error('[credits] Failed to record transaction', { userId, jobId, error: error.message });
      // Don't throw - ledger failure shouldn't block credit operations
    }
  }

  async _getTransactionByJobId(jobId) {
    try {
      const query = await this.firestore
        .collection('credit_ledger')
        .where('jobId', '==', jobId)
        .where('amount', '<', 0) // Only deductions, not refunds
        .limit(1)
        .get();

      if (query.empty) {
        return null;
      }

      const doc = query.docs[0];
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      this.logger.error('[credits] Failed to get transaction by job ID', { jobId, error: error.message });
      return null;
    }
  }

  _getDailyFreeLimit(userId) {
    // Could be user-specific in the future
    return DEFAULT_DAILY_FREE_LIMIT;
  }

  _getTodayKey() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  }
}

export function createCreditsService({ redisClient, firestoreClient, logger } = {}) {
  return new CreditsService({ redisClient, firestoreClient, logger });
}
