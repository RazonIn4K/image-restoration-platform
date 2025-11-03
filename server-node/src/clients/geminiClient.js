import { randomUUID } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { exponentialBackoff } from '../utils/retry.js';

const MODEL_NAME = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-image';

function assertApiKey() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured. Ensure Doppler injects the secret.');
  }
}

function extractCostMetadata(response) {
  const metadata = response?.responseMetadata ?? {};
  const tokenMetadata = metadata?.tokenMetadata ?? {};
  return {
    providerRequestId: metadata?.requestId ?? null,
    billedTokens: tokenMetadata?.totalTokenCount ?? null,
    estimatedCostUsd: metadata?.totalCost ?? null,
  };
}

export class GeminiClient {
  constructor({ apiKey = process.env.GEMINI_API_KEY, model = MODEL_NAME, logger } = {}) {
    assertApiKey();
    this.logger = logger ?? console;
    this.model = model;
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async restoreImage({ prompt, images, userContext }) {
    const tracer = trace.getTracer('restoration');
    const span = tracer.startSpan('gemini.restoreImage', {
      attributes: {
        'ai.model': this.model,
        'ai.operation': 'restoreImage',
        'app.user_id': userContext?.userId ?? 'anonymous',
      },
    });

    try {
      const payload = {
        model: this.model,
        prompt,
        config: {
          size: '1024x1024',
        },
        imageBuffers: images,
      };

      const attemptFn = async () => {
        const response = await context.with(trace.setSpan(context.active(), span), async () =>
          this.client.images.generate(payload)
        );

        const candidate = response?.response?.candidates?.[0];
        const base64Data = candidate?.image?.base64Data;
        if (!base64Data) {
          throw new Error('Gemini response did not include restored image data.');
        }

        const metadata = extractCostMetadata(response);
        span.setAttributes({
          'ai.provider_request_id': metadata.providerRequestId ?? randomUUID(),
          'ai.billed_tokens': metadata.billedTokens ?? 0,
          'ai.estimated_cost_usd': metadata.estimatedCostUsd ?? 0,
        });

        return {
          base64Image: base64Data,
          metadata,
        };
      };

      return await exponentialBackoff({
        attempts: 3,
        minDelayMs: 500,
        factor: 2,
        jitter: 0.3,
        fn: attemptFn,
        onRetry: (error, info) => {
          span.addEvent('gemini.retry', {
            message: error.message,
            attempt: info.attempt,
            nextDelayMs: info.nextDelayMs,
          });
        },
      });
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
      throw error;
    } finally {
      span.end();
    }
  }
}

export function createGeminiClient(options) {
  return new GeminiClient(options);
}
