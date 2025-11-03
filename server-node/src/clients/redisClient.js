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
  const fallbackStore = createInMemoryStore();
  let useFallbackStore = false;

  client.on('error', (err) => {
    console.error('[redis] Client error', err);
  });

  // Atomic token bucket Lua script to prevent race conditions
  const tokenBucketScript = `
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local interval_ms = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    local bucket = redis.call('HMGET', key, 'remaining', 'reset')
    local remaining = tonumber(bucket[1])
    local reset = tonumber(bucket[2])

    if (remaining == nil) or (reset == nil) or (reset <= now) then
      remaining = limit - 1
      reset = now + interval_ms
      redis.call('HMSET', key, 'remaining', remaining, 'reset', reset)
      redis.call('PEXPIRE', key, interval_ms)
      return {1, remaining, reset}
    end

    if remaining <= 0 then
      return {0, 0, reset}
    end

    remaining = remaining - 1
    redis.call('HSET', key, 'remaining', remaining)
    return {1, remaining, reset}
  `;

  const readyPromise = client
    .connect()
    .then(() => {
      console.log('[redis] Connected to Redis instance.');
    })
    .catch((error) => {
      console.error('[redis] Failed to connect. Falling back to in-memory store.', error);
      useFallbackStore = true;
    });

  const store = {
    async ready() {
      return readyPromise;
    },

    async take({ key, limit, intervalSeconds }) {
      if (useFallbackStore) {
        return fallbackStore.take({ key, limit, intervalSeconds });
      }

      const now = Date.now();
      const windowKey = `bucket:${key}`;
      const intervalMs = intervalSeconds * 1000;

      try {
        // Execute atomic token bucket operation using Lua script
        const result = await client.eval(tokenBucketScript, {
          keys: [windowKey],
          arguments: [String(limit), String(intervalMs), String(now)]
        });

        const [allowed, remaining, expiresAt] = result;
        return {
          allowed: Number(allowed) === 1,
          remaining: Number(remaining),
          reset: Number(expiresAt)
        };
      } catch (error) {
        console.error('[redis] Token bucket operation failed. Switching to in-memory store.', error);
        useFallbackStore = true;
        return fallbackStore.take({ key, limit, intervalSeconds });
      }
    },

    async setIdempotency(key, value, ttlSeconds) {
      if (useFallbackStore) {
        return fallbackStore.setIdempotency(key, value, ttlSeconds);
      }
      await client.set(`idem:${key}`, JSON.stringify(value), { EX: ttlSeconds });
    },

    async getIdempotency(key) {
      if (useFallbackStore) {
        return fallbackStore.getIdempotency(key);
      }
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
