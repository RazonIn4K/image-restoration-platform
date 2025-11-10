import { Router } from 'express';
import { getRequestMetrics } from '../metrics/requestMetrics.js';

async function checkRedis(redis) {
  const info = { status: 'ok', mode: redis?.getMode ? redis.getMode() : 'unknown' };

  try {
    if (redis?.isFallback && redis.isFallback()) {
      await redis.ping?.();
      info.status = 'degraded';
      info.reason = 'using in-memory fallback';
      return { info, ok: true, degraded: true };
    }

    if (redis?.ping) {
      await redis.ping();
    } else if (redis?.get) {
      await redis.get('health:ping');
    }

    return { info, ok: true };
  } catch (error) {
    info.status = 'unavailable';
    info.error = error?.message;
    return { info, ok: false };
  }
}

async function checkFirestore(firestore) {
  const info = { status: 'ok' };

  if (!firestore || firestore.isMock) {
    info.status = 'degraded';
    info.reason = 'using mock firestore client';
    return { info, ok: true, degraded: true };
  }

  try {
    if (firestore.healthCheck) {
      await firestore.healthCheck();
    } else if (firestore.collection) {
      await firestore.collection('_health_check').limit(1).get();
    }
    return { info, ok: true };
  } catch (error) {
    info.status = 'unavailable';
    info.error = error?.message;
    return { info, ok: false };
  }
}

async function checkGcs(gcs) {
  const info = { status: 'ok' };

  if (!gcs || gcs.isMock) {
    info.status = 'degraded';
    info.reason = 'using mock gcs client';
    return { info, ok: true, degraded: true };
  }

  try {
    if (gcs.healthCheck) {
      await gcs.healthCheck();
    }
    return { info, ok: true };
  } catch (error) {
    info.status = 'unavailable';
    info.error = error?.message;
    return { info, ok: false };
  }
}

export function createHealthRouter({ clients }) {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.json({ status: 'ok', service: 'image-restoration-api', timestamp: new Date().toISOString() });
  });

  router.get('/ready', async (_req, res) => {
    const [redisStatus, firestoreStatus, gcsStatus] = await Promise.all([
      checkRedis(clients.redis),
      checkFirestore(clients.firestore),
      checkGcs(clients.gcs),
    ]);

    const dependencies = {
      redis: redisStatus.info,
      firestore: firestoreStatus.info,
      gcs: gcsStatus.info,
    };

    const anyFailure = [redisStatus, firestoreStatus, gcsStatus].some((status) => !status.ok);
    const anyDegraded = [redisStatus, firestoreStatus, gcsStatus].some((status) => status.degraded);

    const metrics = getRequestMetrics();

    const payload = {
      status: anyFailure ? 'unready' : anyDegraded ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      metrics: {
        requests: {
          count: metrics.count,
          averageMs: metrics.averageMs,
          p95Ms: metrics.p95Ms,
        },
      },
      dependencies,
    };

    if (anyFailure) {
      res.status(503).json(payload);
    } else {
      res.status(200).json(payload);
    }
  });

  return router;
}
