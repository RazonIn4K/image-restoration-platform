import { createClient as createRedisClient } from 'redis';

const DEFAULT_URL = process.env.REDIS_URL;
const storeCache = new Map();

function createInMemoryStore() {
  const buckets = new Map();
  const idempotency = new Map();
  const kv = new Map();

  const guardExpiration = (map, key) => {
    const entry = map.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      map.delete(key);
      return null;
    }
    return entry;
  };

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
      const entry = guardExpiration(idempotency, key);
      return entry ?? null;
    },

    async eval(script, { keys = [], arguments: args = [] } = {}) {
      if (script.includes('free_usage')) {
        const key = keys[0];
        const limit = Number(args[0] ?? 0);
        const current = Number(await this.get(key) ?? 0);
        if (current >= limit) {
          return 0;
        }
        const newValue = await this.incr(key);
        await this.expire(key, 86400);
        return newValue;
      }
      if (script.includes('remaining') && script.includes('reset')) {
        // Token bucket handling for fallback mode
        const key = keys[0];
        const limit = Number(args[0] ?? 0);
        const intervalMs = Number(args[1] ?? 0);
        const now = Number(args[2] ?? Date.now());
        const bucket = buckets.get(key);
        if (!bucket || bucket.expiresAt <= now) {
          const remaining = limit - 1;
          const reset = now + intervalMs;
          buckets.set(key, { remaining, expiresAt: reset });
          return [1, remaining, reset];
        }
        if (bucket.remaining <= 0) {
          return [0, 0, bucket.expiresAt];
        }
        bucket.remaining -= 1;
        return [1, bucket.remaining, bucket.expiresAt];
      }
      throw new Error('In-memory eval does not support this script.');
    },

    async get(key) {
      const entry = guardExpiration(kv, key);
      return entry ? entry.value : null;
    },

    async set(key, value, options = {}) {
      const expiresAt = options?.EX ? Date.now() + options.EX * 1000 : null;
      kv.set(key, { value: value != null ? String(value) : null, expiresAt });
      return 'OK';
    },

    async expire(key, seconds) {
      const entry = kv.get(key);
      if (!entry) {
        return 0;
      }
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },

    async incrBy(key, amount) {
      const current = Number(await this.get(key) ?? 0);
      const updated = current + amount;
      await this.set(key, updated);
      return updated;
    },

    async incr(key) {
      return this.incrBy(key, 1);
    },

    async decr(key) {
      return this.incrBy(key, -1);
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

    async eval(script, options) {
      if (useFallbackStore) {
        return fallbackStore.eval(script, options);
      }
      return client.eval(script, options);
    },

    async get(key) {
      if (useFallbackStore) {
        return fallbackStore.get(key);
      }
      return client.get(key);
    },

    async set(key, value, options = {}) {
      if (useFallbackStore) {
        return fallbackStore.set(key, value, options);
      }
      if (options?.EX) {
        return client.set(key, value, { EX: options.EX });
      }
      return client.set(key, value);
    },

    async expire(key, seconds) {
      if (useFallbackStore) {
        return fallbackStore.expire(key, seconds);
      }
      return client.expire(key, seconds);
    },

    async incr(key) {
      if (useFallbackStore) {
        return fallbackStore.incr(key);
      }
      return client.incr(key);
    },

    async incrBy(key, amount) {
      if (useFallbackStore) {
        return fallbackStore.incrBy(key, amount);
      }
      return client.incrBy(key, amount);
    },

    async decr(key) {
      if (useFallbackStore) {
        return fallbackStore.decr(key);
      }
      return client.decr(key);
    },
  };

  storeCache.set(cacheKey, store);
  return store;
}
