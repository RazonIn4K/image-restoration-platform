import { createGeminiClient } from '../clients/geminiClient.js';
import { createFirestoreClient } from '../clients/firestoreClient.js';
import { createRedisStore } from '../clients/redisClient.js';
import { createGcsClient } from '../clients/gcsClient.js';

let memoized;

export function getClients() {
  if (!memoized) {
    const redisStore = createRedisStore();
    memoized = {
      gemini: createGeminiClient({}),
      firestore: createFirestoreClient(),
      redis: redisStore,
      gcs: createGcsClient({}),
    };
  }

  return memoized;
}
