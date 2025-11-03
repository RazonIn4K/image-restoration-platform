import { randomUUID } from 'crypto';

const DEFAULT_TYPE = 'about:blank';

export class Problem extends Error {
  constructor({ type = DEFAULT_TYPE, title, status, detail, instance, extras = {} }) {
    super(detail ?? title ?? 'An error occurred');
    this.name = 'Problem';
    this.type = type;
    this.title = title ?? 'Error';
    this.status = status ?? 500;
    this.detail = detail ?? null;
    this.instance = instance ?? null;
    this.extras = extras;
  }
}

export const isProblem = (value) => value instanceof Problem;

export function createProblem(params = {}) {
  return new Problem(params);
}

export function problemResponse({ res, problem, requestId }) {
  const instance = problem.instance ?? requestId ?? randomUUID();
  const body = {
    type: problem.type ?? DEFAULT_TYPE,
    title: problem.title,
    status: problem.status,
    detail: problem.detail ?? undefined,
    instance,
    ...problem.extras,
  };

  res
    .status(problem.status)
    .type('application/problem+json')
    .set('Content-Type', 'application/problem+json')
    .set('X-Request-Id', requestId ?? instance);

  if (!res.getHeader('Cache-Control')) {
    res.set('Cache-Control', 'no-store');
  }

  res.json(body);
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const requestId = req.context?.requestId ?? randomUUID();

  if (isProblem(err)) {
    return problemResponse({ res, problem: err, requestId });
  }

  console.error('[error] Unhandled exception', {
    requestId,
    message: err?.message,
    stack: err?.stack,
  });

  const problem = new Problem({
    type: DEFAULT_TYPE,
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred.',
  });

  return problemResponse({ res, problem, requestId });
}
