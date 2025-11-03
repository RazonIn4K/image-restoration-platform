import { createProblem } from '../utils/problem.js';
import { createRedisStore } from '../clients/redisClient.js';

const DEFAULT_LIMIT = 60;
const DEFAULT_INTERVAL = 60; // seconds

class InMemoryTokenBucketStore {
  constructor() {
    this.buckets = new Map();
  }

  _getBucket(key, now, windowMs, limit) {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      const expiresAt = now + windowMs;
      const nextBucket = { remaining: limit, expiresAt };
      this.buckets.set(key, nextBucket);
      return nextBucket;
    }
    return bucket;
  }

  async take({ key, limit, intervalSeconds }) {
    const now = Date.now();
    const windowMs = intervalSeconds * 1000;
    const bucket = this._getBucket(key, now, windowMs, limit);

    if (bucket.remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        reset: bucket.expiresAt,
      };
    }

    bucket.remaining -= 1;
    return {
      allowed: true,
      remaining: bucket.remaining,
      reset: bucket.expiresAt,
    };
  }
}

const memoryStore = new InMemoryTokenBucketStore();
const redisStore = createRedisStore();

if (typeof redisStore?.ready === 'function') {
  redisStore.ready().catch((error) => {
    console.warn('[rate-limit] Redis connection not ready; defaulting to in-memory store.', error?.message);
  });
}

function toHeaderTuple({ limit, remaining, reset }) {
  const resetSeconds = Math.max(0, Math.ceil((reset - Date.now()) / 1000));
  return {
    limit,
    remaining: Math.max(0, remaining),
    reset: resetSeconds,
  };
}

export function rateLimitMiddleware({ store } = {}) {
  const bucketStore =
    store ?? (typeof redisStore.take === 'function' ? redisStore : memoryStore);

  return async function expressRateLimit(req, res, next) {
    const limitConfigs = [];

    const userId = req.user?.id;
    if (userId) {
      limitConfigs.push({
        key: `user:${userId}`,
        limit: Number(process.env.RATE_LIMIT_USER_LIMIT ?? 120),
        intervalSeconds: Number(process.env.RATE_LIMIT_USER_INTERVAL ?? 60),
        detail: 'User rate limit exceeded.',
      });
    }

    limitConfigs.push({
      key: `ip:${req.ip}`,
      limit: Number(process.env.RATE_LIMIT_IP_LIMIT ?? 100),
      intervalSeconds: Number(process.env.RATE_LIMIT_IP_INTERVAL ?? 60),
      detail: `IP rate limit exceeded for ${req.ip}.`,
    });

    let headerValues = null;

    for (const config of limitConfigs) {
      const result = await bucketStore.take(config);
      const headers = toHeaderTuple({ limit: config.limit, remaining: result.remaining, reset: result.reset });

      if (!headerValues || headers.remaining < headerValues.remaining) {
        headerValues = headers;
      }

      if (!result.allowed) {
        res.setHeader('RateLimit-Limit', headers.limit);
        res.setHeader('RateLimit-Remaining', headers.remaining);
        res.setHeader('RateLimit-Reset', headers.reset);

        const retryAfter = Math.max(1, headers.reset);
        res.setHeader('Retry-After', retryAfter);

        return next(
          createProblem({
            type: 'https://httpstatuses.com/429',
            title: 'Too Many Requests',
            status: 429,
            detail: config.detail,
            extras: {
              retryAfter,
            },
          })
        );
      }
    }

    if (headerValues) {
      res.setHeader('RateLimit-Limit', headerValues.limit);
      res.setHeader('RateLimit-Remaining', headerValues.remaining);
      res.setHeader('RateLimit-Reset', headerValues.reset);
    }

    return next();
  };
}
