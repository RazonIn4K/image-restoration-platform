import { createClient as createRedisClient } from 'redis';

const DEFAULT_URL = process.env.REDIS_URL;
const storeCache = new Map();

function createInMemoryStore() {
  const buckets = new Map();
  const idempotency = new Map();

  return {
    async take({ key, limit, intervalSeconds }) {
      const now = Date.now();
      const windowMs = intervalSeconds * 1000;
      const bucket = buckets.get(key);
      if (!bucket || bucket.expiresAt <= now) {
        const expiresAt = now + windowMs;
        buckets.set(key, { remaining: limit - 1, expiresAt });
        return { allowed: true, remaining: limit - 1, reset: expiresAt };
      }
      if (bucket.remaining <= 0) {
        return { allowed: false, remaining: 0, reset: bucket.expiresAt };
      }
      bucket.remaining -= 1;
      return { allowed: true, remaining: bucket.remaining, reset: bucket.expiresAt };
    },

    async setIdempotency(key, value, ttlSeconds) {
      const expiresAt = Date.now() + ttlSeconds * 1000;
      idempotency.set(key, { ...value, expiresAt });
    },

    async getIdempotency(key) {
      const entry = idempotency.get(key);
      if (!entry || entry.expiresAt <= Date.now()) {
        idempotency.delete(key);
        return null;
      }
      return entry;
    },

    async set(key, value, ttlSeconds) {
      return this.setIdempotency(key, value, ttlSeconds);
    },

    async get(key) {
      return this.getIdempotency(key);
    },
  };
}

export function createRedisStore({ url = DEFAULT_URL } = {}) {
  const cacheKey = url ?? 'memory';
  if (storeCache.has(cacheKey)) {
    return storeCache.get(cacheKey);
  }

  if (!url) {
    console.warn('[redis] REDIS_URL missing; using in-memory store.');
    const store = createInMemoryStore();
    storeCache.set(cacheKey, store);
    return store;
  }

  const client = createRedisClient({ url });
  client.on('error', (err) => {
    console.error('[redis] Client error', err);
  });

  const readyPromise = client
    .connect()
    .then(() => {
      console.log('[redis] Connected to Redis instance.');
    })
    .catch((error) => {
      console.error('[redis] Failed to connect. Falling back to in-memory store.', error);
    });

  const store = {
    async ready() {
      return readyPromise;
    },

    async take({ key, limit, intervalSeconds }) {
      const now = Date.now();
      const windowKey = `bucket:${key}`;
      const ttlSeconds = intervalSeconds;

      const data = await client.hGetAll(windowKey);
      let remaining = Number.parseInt(data.remaining ?? '', 10);
      let expiresAt = Number.parseInt(data.expiresAt ?? '', 10);

      if (!Number.isFinite(remaining) || !Number.isFinite(expiresAt) || expiresAt <= now) {
        remaining = limit - 1;
        expiresAt = now + ttlSeconds * 1000;
        await client.hSet(windowKey, {
          remaining: String(remaining),
          expiresAt: String(expiresAt),
        });
        await client.expire(windowKey, ttlSeconds);
        return { allowed: true, remaining, reset: expiresAt };
      }

      if (remaining <= 0) {
        return { allowed: false, remaining: 0, reset: expiresAt };
      }

      remaining -= 1;
      await client.hSet(windowKey, { remaining: String(remaining) });
      return { allowed: true, remaining, reset: expiresAt };
    },

    async setIdempotency(key, value, ttlSeconds) {
      await client.set(`idem:${key}`, JSON.stringify(value), { EX: ttlSeconds });
    },

    async getIdempotency(key) {
      const raw = await client.get(`idem:${key}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (error) {
        console.error('[redis] Failed to parse idempotency payload', error);
        return null;
      }
    },

    async set(key, value, ttlSeconds) {
      return this.setIdempotency(key, value, ttlSeconds);
    },

    async get(key) {
      return this.getIdempotency(key);
    },
  };

  storeCache.set(cacheKey, store);
  return store;
}
