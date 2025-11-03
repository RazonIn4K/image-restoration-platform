import { ImageAnnotatorClient } from '@google-cloud/vision';
import { createClassifierService } from '../services/classifier.js';
import { createPromptEnhancerService } from '../services/promptEnhancer.js';
import { createRestoratorService } from '../services/restorator.js';
import { createCreditsService } from '../services/credits.js';
import { createModerationService } from '../services/moderation.js';

/**
 * Service Factory - Creates and manages all business logic services
 * Integrates services with the client layer and provides centralized access
 */

let memoizedServices;

function createVisionClient() {
  try {
    const rawCreds = process.env.FIRESTORE_CREDS;
    if (!rawCreds) {
      return null;
    }

    // Decode base64-encoded credentials
    let creds;
    try {
      const decoded = Buffer.from(rawCreds, 'base64').toString('utf-8');
      creds = JSON.parse(decoded);
    } catch (error) {
      // Fallback: try parsing as raw JSON for development
      creds = JSON.parse(rawCreds);
    }

    return new ImageAnnotatorClient({
      credentials: creds
    });
  } catch (error) {
    console.warn('[services] Vision client not available:', error.message);
    return null;
  }
}

export function getServices(clients) {
  if (!memoizedServices) {
    const visionClient = createVisionClient();
    
    memoizedServices = {
      classifier: createClassifierService({
        logger: console
      }),
      
      promptEnhancer: createPromptEnhancerService({
        logger: console
      }),
      
      restorator: createRestoratorService({
        geminiClient: clients.gemini,
        logger: console
      }),
      
      credits: createCreditsService({
        redisClient: clients.redis,
        firestoreClient: clients.firestore,
        logger: console
      }),
      
      moderation: createModerationService({
        visionClient,
        logger: console
      })
    };
  }

  return memoizedServices;
}

export function attachServices() {
  return (req, _res, next) => {
    if (!req.clients) {
      return next(new Error('Services middleware requires clients to be attached first'));
    }
    
    req.services = getServices(req.clients);
    next();
  };
}