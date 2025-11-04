import { trace, SpanStatusCode } from '@opentelemetry/api';

/**
 * Moderation Service - Content filtering using Google Vision SafeSearch API
 * 
 * Implements documented thresholds:
 * - Reject: LIKELY or VERY_LIKELY ratings for adult/violence/racy content
 * - Log all moderation flags for audit purposes
 * - Return structured moderation results
 */

const REJECTION_THRESHOLDS = {
  adult: ['LIKELY', 'VERY_LIKELY'],
  violence: ['LIKELY', 'VERY_LIKELY'], 
  racy: ['LIKELY', 'VERY_LIKELY']
};

const LIKELIHOOD_SCORES = {
  'UNKNOWN': 0,
  'VERY_UNLIKELY': 1,
  'UNLIKELY': 2,
  'POSSIBLE': 3,
  'LIKELY': 4,
  'VERY_LIKELY': 5
};

let moderationLoggingWarningLogged = false;

export class ModerationService {
  constructor({ visionClient, firestoreClient, logger } = {}) {
    this.visionClient = visionClient;
    this.logger = logger ?? console;
    this.firestore = firestoreClient;
    this.useMockModeration = !visionClient;
    
    if (this.useMockModeration) {
      this.logger.warn('[moderation] Using mock moderation - Vision API client not available');
    }
  }

  /**
   * Moderate image content using Google Vision SafeSearch
   * @param {Buffer} imageBuffer - Image to moderate
   * @param {Object} context - Additional context (userId, jobId, etc.)
   * @returns {Promise<Object>} Moderation result with flags and decision
   */
  async moderate(imageBuffer, context = {}) {
    const tracer = trace.getTracer('moderation');
    const span = tracer.startSpan('moderation.moderate', {
      attributes: {
        'moderation.user_id': context.userId || 'anonymous',
        'moderation.job_id': context.jobId || 'unknown',
        'moderation.image_size_bytes': imageBuffer.length,
        'moderation.use_mock': this.useMockModeration
      }
    });

    try {
      this.logger.debug('[moderation] Starting content moderation', {
        userId: context.userId,
        jobId: context.jobId,
        imageSize: imageBuffer.length,
        useMock: this.useMockModeration
      });

      let moderationResult;

      if (this.useMockModeration) {
        moderationResult = this._getMockModerationResult(imageBuffer);
      } else {
        moderationResult = await this._performSafeSearchModeration(imageBuffer);
      }

      // Determine if content should be rejected
      const rejection = this._evaluateRejection(moderationResult.flags);
      
      const result = {
        allowed: !rejection.rejected,
        flags: moderationResult.flags,
        rejection: rejection.rejected ? {
          reason: rejection.reason,
          categories: rejection.categories
        } : null,
        confidence: this._calculateOverallConfidence(moderationResult.flags),
        timestamp: new Date().toISOString()
      };

      span.setAttributes({
        'moderation.allowed': result.allowed,
        'moderation.rejection_reason': rejection.reason || 'none',
        'moderation.flagged_categories': rejection.categories?.join(',') || 'none',
        'moderation.confidence': result.confidence
      });

      if (!result.allowed) {
        this.logger.warn('[moderation] Content rejected', {
          userId: context.userId,
          jobId: context.jobId,
          reason: rejection.reason,
          categories: rejection.categories,
          flags: moderationResult.flags
        });
      } else {
        this.logger.debug('[moderation] Content approved', {
          userId: context.userId,
          jobId: context.jobId,
          flags: moderationResult.flags
        });
      }

      span.setStatus({ code: SpanStatusCode.OK });
      await this._recordModerationAudit(result, context);
      return result;

    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      
      this.logger.error('[moderation] Moderation failed', {
        userId: context.userId,
        jobId: context.jobId,
        error: error.message
      });

      const failureResult = {
        allowed: false,
        flags: {
          adult: 'UNKNOWN',
          violence: 'UNKNOWN',
          racy: 'UNKNOWN',
          spoof: 'UNKNOWN',
          medical: 'UNKNOWN'
        },
        rejection: {
          reason: 'Moderation service unavailable. Content rejected as a precaution.',
          categories: ['moderation-service-error'],
        },
        error: {
          message: error.message,
          code: 'MODERATION_SERVICE_ERROR'
        },
        confidence: 1,
        timestamp: new Date().toISOString()
      };

      await this._recordModerationAudit(failureResult, context);
      return failureResult;

    } finally {
      span.end();
    }
  }

  /**
   * Perform SafeSearch moderation using Google Vision API
   */
  async _performSafeSearchModeration(imageBuffer) {
    try {
      const [result] = await this.visionClient.safeSearchDetection({
        image: { content: imageBuffer }
      });

      const safeSearch = result.safeSearchAnnotation;
      
      return {
        flags: {
          adult: safeSearch.adult || 'UNKNOWN',
          violence: safeSearch.violence || 'UNKNOWN',
          racy: safeSearch.racy || 'UNKNOWN',
          spoof: safeSearch.spoof || 'UNKNOWN',
          medical: safeSearch.medical || 'UNKNOWN'
        }
      };

    } catch (error) {
      this.logger.error('[moderation] SafeSearch API call failed', { error: error.message });
      throw new Error(`SafeSearch moderation failed: ${error.message}`);
    }
  }

  /**
   * Generate mock moderation result for development/testing
   */
  _getMockModerationResult(imageBuffer) {
    // Generate deterministic but varied results based on image size
    const seed = imageBuffer.length % 100;
    
    // Most images should pass moderation in development
    if (seed < 85) {
      return {
        flags: {
          adult: 'VERY_UNLIKELY',
          violence: 'UNLIKELY', 
          racy: 'UNLIKELY',
          spoof: 'POSSIBLE',
          medical: 'UNLIKELY'
        }
      };
    }
    
    // Occasionally simulate flagged content for testing
    if (seed < 95) {
      return {
        flags: {
          adult: 'POSSIBLE',
          violence: 'UNLIKELY',
          racy: 'POSSIBLE', 
          spoof: 'LIKELY',
          medical: 'UNLIKELY'
        }
      };
    }

    // Rarely simulate rejected content
    return {
      flags: {
        adult: 'LIKELY',
        violence: 'POSSIBLE',
        racy: 'VERY_LIKELY',
        spoof: 'POSSIBLE',
        medical: 'UNLIKELY'
      }
    };
  }

  /**
   * Evaluate whether content should be rejected based on flags
   */
  _evaluateRejection(flags) {
    const rejectedCategories = [];
    
    for (const [category, thresholds] of Object.entries(REJECTION_THRESHOLDS)) {
      const flagValue = flags[category];
      if (thresholds.includes(flagValue)) {
        rejectedCategories.push(category);
      }
    }

    if (rejectedCategories.length > 0) {
      return {
        rejected: true,
        reason: 'Content violates community guidelines',
        categories: rejectedCategories
      };
    }

    return { rejected: false };
  }

  /**
   * Calculate overall confidence score for moderation decision
   */
  _calculateOverallConfidence(flags) {
    const scores = Object.values(flags).map(flag => LIKELIHOOD_SCORES[flag] || 0);
    const maxScore = Math.max(...scores);
    return maxScore / 5; // Normalize to 0-1 range
  }

  async _recordModerationAudit(result, context) {
    if (!this.firestore) {
      if (!moderationLoggingWarningLogged) {
        this.logger.warn('[moderation] Firestore client unavailable; moderation audits will not be persisted.');
        moderationLoggingWarningLogged = true;
      }
      return;
    }

    try {
      await this.firestore.collection('moderation_logs').add({
        userId: context.userId || null,
        jobId: context.jobId || null,
        requestId: context.requestId || null,
        allowed: result.allowed,
        flags: result.flags,
        rejection: result.rejection || null,
        error: result.error || null,
        confidence: result.confidence,
        timestamp: result.timestamp || new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('[moderation] Failed to persist moderation audit', {
        userId: context.userId,
        jobId: context.jobId,
        error: error.message,
      });
    }
  }

  /**
   * Get moderation statistics for monitoring
   */
  async getModerationStats(timeRange = '24h') {
    // This would typically query a database of moderation results
    // For now, return mock stats
    return {
      timeRange,
      totalModerated: 0,
      approved: 0,
      rejected: 0,
      rejectionReasons: {},
      averageConfidence: 0,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Validate moderation configuration
   */
  static validateConfig() {
    // Verify thresholds are properly configured
    for (const [category, thresholds] of Object.entries(REJECTION_THRESHOLDS)) {
      if (!Array.isArray(thresholds) || thresholds.length === 0) {
        throw new Error(`Invalid rejection thresholds for category: ${category}`);
      }
      
      for (const threshold of thresholds) {
        if (!(threshold in LIKELIHOOD_SCORES)) {
          throw new Error(`Invalid likelihood threshold: ${threshold}`);
        }
      }
    }
    
    return true;
  }

  /**
   * Get current moderation policy for documentation
   */
  static getModerationPolicy() {
    return {
      description: 'Content moderation using Google Vision SafeSearch API',
      rejectionThresholds: { ...REJECTION_THRESHOLDS },
      categories: {
        adult: 'Adult content detection',
        violence: 'Violence and graphic content detection',
        racy: 'Racy or suggestive content detection',
        spoof: 'Spoof or fake content detection (logged but not rejected)',
        medical: 'Medical content detection (logged but not rejected)'
      },
      likelihoodLevels: Object.keys(LIKELIHOOD_SCORES),
      failureMode: 'Reject content if moderation service fails (fail-closed)'
    };
  }
}

export function createModerationService({ visionClient, firestoreClient, logger } = {}) {
  return new ModerationService({ visionClient, firestoreClient, logger });
}
