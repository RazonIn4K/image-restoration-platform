import pino from 'pino';
import { trace } from '@opentelemetry/api';
import { createGeminiClient } from '../clients/geminiClient.js';
import { createFirestoreClient } from '../clients/firestoreClient.js';
import { createRedisStore } from '../clients/redisClient.js';
import { createGcsClient } from '../clients/gcsClient.js';

let memoized;

export function getClients() {
  if (!memoized) {
    const redisStore = createRedisStore();
    const logger = pino({
      level: process.env.LOG_LEVEL ?? 'info',
      base: undefined,
      name: 'image-restoration-backend',
      mixin() {
        const span = trace.getActiveSpan();
        if (!span) {
          return {};
        }
        const spanContext = span.spanContext();
        if (!spanContext) {
          return {};
        }
        return {
          trace_id: spanContext.traceId,
          span_id: spanContext.spanId,
        };
      },
    });
    memoized = {
      gemini: createGeminiClient({}),
      firestore: createFirestoreClient(),
      redis: redisStore,
      gcs: createGcsClient({}),
      logger,
    };
  }

  return memoized;
}
