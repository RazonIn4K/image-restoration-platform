import { randomUUID } from 'crypto';
import { vi } from 'vitest';

class LedgerQuery {
  constructor(records) {
    this.records = records;
  }

  where(field, operator, value) {
    let filtered = this.records;
    if (operator === '==') {
      filtered = filtered.filter((item) => item[field] === value);
    } else if (operator === '<') {
      filtered = filtered.filter((item) => item[field] < value);
    } else if (operator === '>') {
      filtered = filtered.filter((item) => item[field] > value);
    } else {
      throw new Error(`Unsupported operator: ${operator}`);
    }
    return new LedgerQuery(filtered);
  }

  limit(count) {
    return new LedgerQuery(this.records.slice(0, count));
  }

  async get() {
    return {
      empty: this.records.length === 0,
      docs: this.records.map((record) => ({
        id: record.id,
        data: () => ({ ...record }),
      })),
    };
  }
}

export function createFirestoreMock() {
  const users = new Map();
  const ledger = [];

  return {
    isMock: true,
    collection(name) {
      if (name === 'credit_ledger') {
        return {
          async add(entry) {
            const record = { id: randomUUID(), ...entry };
            ledger.push(record);
            return { id: record.id };
          },
          where(field, operator, value) {
            return new LedgerQuery(ledger).where(field, operator, value);
          },
        };
      }

      if (name === 'users') {
        return {
          doc(id) {
            return {
              async set(data, options = {}) {
                if (options.merge) {
                  const existing = users.get(id) ?? {};
                  users.set(id, { ...existing, ...data });
                } else {
                  users.set(id, { ...data });
                }
              },
              async get() {
                const data = users.get(id);
                return {
                  exists: Boolean(data),
                  data: () => data,
                };
              },
            };
          },
        };
      }

      throw new Error(`Unsupported collection: ${name}`);
    },
    async healthCheck() {
      return { ok: true };
    },
    __getLedger() {
      return ledger;
    },
    __getUserDoc(id) {
      return users.get(id);
    },
  };
}

export function createRedisMock() {
  const store = new Map();
  const expirations = new Map();

  const getValue = (key) => {
    const expiresAt = expirations.get(key);
    if (expiresAt && expiresAt <= Date.now()) {
      store.delete(key);
      expirations.delete(key);
      return null;
    }
    return store.has(key) ? store.get(key) : null;
  };

  return {
    async get(key) {
      const value = getValue(key);
      return value === null || value === undefined ? null : String(value);
    },
    async set(key, value, options = {}) {
      store.set(key, value);
      if (options?.EX) {
        expirations.set(key, Date.now() + options.EX * 1000);
      } else {
        expirations.delete(key);
      }
      return 'OK';
    },
    async expire(key, seconds) {
      if (!store.has(key)) {
        return 0;
      }
      expirations.set(key, Date.now() + seconds * 1000);
      return 1;
    },
    async incrBy(key, amount) {
      const current = Number((await this.get(key)) ?? 0);
      const next = current + amount;
      await this.set(key, next);
      return next;
    },
    async incr(key) {
      return this.incrBy(key, 1);
    },
    async decr(key) {
      return this.incrBy(key, -1);
    },
    async eval(_script, { keys = [], arguments: args = [] } = {}) {
      const key = keys[0];
      if (!key) {
        throw new Error('Missing key for eval');
      }

      if (key.startsWith('free_usage:')) {
        const limit = Number(args[0] ?? 0);
        const current = Number((await this.get(key)) ?? 0);
        if (current >= limit) {
          return 0;
        }
        const next = current + 1;
        await this.set(key, next);
        await this.expire(key, 86400);
        return next;
      }

      if (key.startsWith('credits:')) {
        const amount = Number(args[0] ?? 0);
        const current = Number((await this.get(key)) ?? 0);
        if (current < amount) {
          return [0, current];
        }
        const newBalance = current - amount;
        await this.set(key, newBalance, { EX: 60 });
        return [1, newBalance];
      }

      throw new Error(`Unsupported eval script for key: ${key}`);
    },
  };
}

export function createTestLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
