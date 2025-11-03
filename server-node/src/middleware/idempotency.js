import { createHash } from 'crypto';
import { createProblem } from '../utils/problem.js';
import { createRedisStore } from '../clients/redisClient.js';

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h

const fallbackStore = createRedisStore();

function hashPayload(req) {
  const hash = createHash('sha256');
  hash.update(req.method);
  hash.update(req.originalUrl ?? req.url ?? '');

  if (req.body && Object.keys(req.body).length > 0) {
    try {
      hash.update(JSON.stringify(req.body));
    } catch (error) {
      hash.update(String(req.body));
    }
  }

  return hash.digest('hex');
}

function captureResponse(res) {
  const { locals } = res;
  if (!locals.__idempotency) {
    locals.__idempotency = {};
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    locals.__idempotency.body = body;
    locals.__idempotency.isJson = true;
    locals.__idempotency.status = res.statusCode;
    locals.__idempotency.headers = { ...res.getHeaders() };
    return originalJson(body);
  };

  const originalSend = res.send.bind(res);
  res.send = (body) => {
    locals.__idempotency.body = body;
    locals.__idempotency.isJson = false;
    locals.__idempotency.status = res.statusCode;
    locals.__idempotency.headers = { ...res.getHeaders() };
    return originalSend(body);
  };
}

export function idempotencyMiddleware({ store, ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const backingStore = store ?? {
    set: (key, value, ttl) => fallbackStore.setIdempotency(key, value, ttl),
    get: (key) => fallbackStore.getIdempotency(key),
  };

  return async function idempotencyHandler(req, res, next) {
    if (req.method.toUpperCase() !== 'POST') {
      return next();
    }

    const key = req.header('Idempotency-Key');
    if (!key) {
      return next(
        createProblem({
          type: 'https://docs.image-restoration.ai/problem/idempotency-key-missing',
          title: 'Idempotency Key Required',
          status: 400,
          detail: 'The Idempotency-Key header is required for this endpoint.',
        })
      );
    }

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(key)) {
      return next(
        createProblem({
          type: 'https://docs.image-restoration.ai/problem/idempotency-key-invalid',
          title: 'Invalid Idempotency Key',
          status: 400,
          detail: 'The Idempotency-Key header must be a valid token.',
        })
      );
    }

    const payloadHash = hashPayload(req);
    const cached = await backingStore.get(key);

    if (cached) {
      if (cached.payloadHash !== payloadHash) {
        return next(
          createProblem({
            type: 'https://docs.image-restoration.ai/problem/idempotency-conflict',
            title: 'Idempotency Conflict',
            status: 409,
            detail: 'A request with the same Idempotency-Key but different payload already exists.',
          })
        );
      }

      res.status(cached.response.status);
      for (const [headerName, headerValue] of Object.entries(cached.response.headers)) {
        if (headerName.toLowerCase() === 'content-length') {
          continue;
        }
        res.setHeader(headerName, headerValue);
      }

      if (cached.response.isJson) {
        return res.json(cached.response.body);
      }
      return res.send(cached.response.body);
    }

    captureResponse(res);

    res.on('finish', async () => {
      const meta = res.locals.__idempotency;
      if (!meta) {
        return;
      }

      if (meta.status >= 200 && meta.status < 500) {
        await backingStore.set(
          key,
          {
            payloadHash,
            response: {
              status: meta.status,
              headers: meta.headers,
              body: meta.body,
              isJson: meta.isJson,
            },
          },
          ttlSeconds
        );
      }
    });

    return next();
  };
}
