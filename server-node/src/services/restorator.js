import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { createClassifierService } from './classifier.js';
import { createPromptEnhancerService } from './promptEnhancer.js';

/**
 * Restorator Service - Orchestrates the complete image restoration workflow
 * 
 * Workflow: Image → Classification → Prompt Enhancement → AI Restoration → Result
 * Includes retry logic, cost tracking, and comprehensive error handling
 */

export class RestoratorService {
  constructor({ geminiClient, logger } = {}) {
    if (!geminiClient) {
      throw new Error('RestoratorService requires a geminiClient');
    }
    
    this.geminiClient = geminiClient;
    this.logger = logger ?? console;
    this.classifier = createClassifierService({ logger });
    this.promptEnhancer = createPromptEnhancerService({ logger });
  }

  /**
   * Restore an image using the complete AI-powered workflow
   * @param {Object} params - Restoration parameters
   * @param {Buffer} params.imageBuffer - Input image buffer
   * @param {string} params.userPrompt - Optional user prompt
   * @param {Object} params.userContext - User context (userId, etc.)
   * @param {Object} params.options - Additional options
   * @returns {Promise<Object>} Restoration result with metadata
   */
  async restore({ imageBuffer, userPrompt, userContext, options = {} }) {
    const tracer = trace.getTracer('restorator');
    const span = tracer.startSpan('restorator.restore', {
      attributes: {
        'restoration.user_id': userContext?.userId || 'anonymous',
        'restoration.has_user_prompt': !!userPrompt,
        'restoration.image_size_bytes': imageBuffer.length
      }
    });

    const startTime = Date.now();
    const timings = {};

    try {
      this.logger.info('[restorator] Starting restoration workflow', {
        userId: userContext?.userId,
        imageSize: imageBuffer.length,
        hasUserPrompt: !!userPrompt
      });

      // Step 1: Classify image degradation
      const classifyStart = Date.now();
      const degradation = await context.with(trace.setSpan(context.active(), span), () =>
        this.classifier.analyze(imageBuffer)
      );
      timings.classify_ms = Date.now() - classifyStart;

      span.addEvent('classification_complete', {
        'classification.duration_ms': timings.classify_ms,
        'classification.issues_detected': Object.entries(degradation)
          .filter(([_, score]) => score > 0.3).length
      });

      // Step 2: Enhance prompt based on degradation analysis
      const promptStart = Date.now();
      const enhancedPrompt = await context.with(trace.setSpan(context.active(), span), () =>
        this.promptEnhancer.enhance({
          degradation,
          userPrompt,
          options
        })
      );
      timings.prompt_ms = Date.now() - promptStart;

      span.addEvent('prompt_enhancement_complete', {
        'prompt.duration_ms': timings.prompt_ms,
        'prompt.final_length': enhancedPrompt.length
      });

      // Step 3: Perform AI restoration
      const restoreStart = Date.now();
      const restorationResult = await context.with(trace.setSpan(context.active(), span), () =>
        this.geminiClient.restoreImage({
          prompt: enhancedPrompt,
          images: [imageBuffer],
          userContext
        })
      );
      timings.restore_ms = Date.now() - restoreStart;

      // Calculate total time
      timings.total_ms = Date.now() - startTime;

      span.addEvent('restoration_complete', {
        'restoration.duration_ms': timings.restore_ms,
        'restoration.total_duration_ms': timings.total_ms
      });

      // Prepare final result
      const result = {
        success: true,
        restoredImage: restorationResult.base64Image,
        degradationAnalysis: degradation,
        enhancedPrompt,
        timings,
        metadata: {
          providerRequestId: restorationResult.metadata.providerRequestId,
          estimatedCostUsd: restorationResult.metadata.estimatedCostUsd,
          billedTokens: restorationResult.metadata.billedTokens,
          processingTime: timings.total_ms,
          classificationIssues: Object.entries(degradation)
            .filter(([_, score]) => score > 0.3)
            .map(([type, score]) => ({ type, confidence: score }))
        }
      };

      span.setAttributes({
        'restoration.success': true,
        'restoration.cost_usd': restorationResult.metadata.estimatedCostUsd || 0,
        'restoration.provider_request_id': restorationResult.metadata.providerRequestId || 'unknown',
        'restoration.total_duration_ms': timings.total_ms
      });

      this.logger.info('[restorator] Restoration completed successfully', {
        userId: userContext?.userId,
        timings,
        costUsd: restorationResult.metadata.estimatedCostUsd,
        providerRequestId: restorationResult.metadata.providerRequestId,
        issuesDetected: result.metadata.classificationIssues.length
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return result;

    } catch (error) {
      timings.total_ms = Date.now() - startTime;

      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

      this.logger.error('[restorator] Restoration failed', {
        userId: userContext?.userId,
        error: error.message,
        timings,
        stack: error.stack
      });

      // Return structured error result
      return {
        success: false,
        error: {
          message: error.message,
          code: error.code || 'RESTORATION_FAILED',
          type: this._classifyError(error)
        },
        timings,
        metadata: {
          processingTime: timings.total_ms,
          failureStage: this._determineFailureStage(timings)
        }
      };

    } finally {
      span.end();
    }
  }

  /**
   * Restore multiple images in batch (for future multi-image support)
   * @param {Array} images - Array of image buffers
   * @param {string} userPrompt - Optional user prompt
   * @param {Object} userContext - User context
   * @returns {Promise<Array>} Array of restoration results
   */
  async restoreBatch({ images, userPrompt, userContext, options = {} }) {
    const tracer = trace.getTracer('restorator');
    const span = tracer.startSpan('restorator.restoreBatch', {
      attributes: {
        'restoration.batch_size': images.length,
        'restoration.user_id': userContext?.userId || 'anonymous'
      }
    });

    try {
      this.logger.info('[restorator] Starting batch restoration', {
        userId: userContext?.userId,
        batchSize: images.length
      });

      // Process images sequentially to avoid overwhelming the AI service
      const results = [];
      for (let i = 0; i < images.length; i++) {
        const imageResult = await this.restore({
          imageBuffer: images[i],
          userPrompt,
          userContext,
          options: { ...options, batchIndex: i, batchSize: images.length }
        });
        results.push(imageResult);

        // Add delay between requests to respect rate limits
        if (i < images.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      span.setAttributes({
        'restoration.batch_success_count': results.filter(r => r.success).length,
        'restoration.batch_failure_count': results.filter(r => !r.success).length
      });

      this.logger.info('[restorator] Batch restoration completed', {
        userId: userContext?.userId,
        successCount: results.filter(r => r.success).length,
        failureCount: results.filter(r => !r.success).length
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return results;

    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Classify error type for better error handling
   */
  _classifyError(error) {
    const message = error.message.toLowerCase();
    
    if (message.includes('rate limit') || message.includes('429')) {
      return 'RATE_LIMIT_EXCEEDED';
    }
    
    if (message.includes('timeout') || message.includes('etimedout')) {
      return 'TIMEOUT';
    }
    
    if (message.includes('invalid') || message.includes('400')) {
      return 'INVALID_INPUT';
    }
    
    if (message.includes('unauthorized') || message.includes('401')) {
      return 'AUTHENTICATION_FAILED';
    }
    
    if (message.includes('service unavailable') || message.includes('503')) {
      return 'SERVICE_UNAVAILABLE';
    }
    
    return 'UNKNOWN_ERROR';
  }

  /**
   * Determine which stage of the workflow failed
   */
  _determineFailureStage(timings) {
    if (timings.classify_ms && !timings.prompt_ms) {
      return 'PROMPT_ENHANCEMENT';
    }
    
    if (timings.prompt_ms && !timings.restore_ms) {
      return 'AI_RESTORATION';
    }
    
    if (!timings.classify_ms) {
      return 'CLASSIFICATION';
    }
    
    return 'UNKNOWN';
  }

  /**
   * Get service health status
   */
  async getHealthStatus() {
    try {
      // Test basic functionality with a small test image
      const testImage = Buffer.alloc(100); // Minimal test buffer
      
      const classifierHealthy = await this.classifier.analyze(testImage)
        .then(() => true)
        .catch(() => false);

      return {
        healthy: classifierHealthy,
        services: {
          classifier: classifierHealthy,
          promptEnhancer: true, // No external dependencies
          geminiClient: true // Health checked separately
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

export function createRestoratorService({ geminiClient, logger } = {}) {
  return new RestoratorService({ geminiClient, logger });
}