import pino from 'pino';
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
