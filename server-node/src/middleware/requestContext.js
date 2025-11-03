import { randomUUID } from 'crypto';

const TRACE_PARENT_HEADER = 'traceparent';
const TRACE_STATE_HEADER = 'tracestate';
const REQUEST_ID_HEADER = 'x-request-id';

export function requestContext() {
  return (req, res, next) => {
    const headerRequestId = req.header(REQUEST_ID_HEADER);
    const requestId = headerRequestId && headerRequestId.trim() ? headerRequestId.trim() : randomUUID();

    const traceparent = req.header(TRACE_PARENT_HEADER);
    const tracestate = req.header(TRACE_STATE_HEADER);

    req.context = {
      ...(req.context ?? {}),
      requestId,
      traceparent: traceparent ?? null,
      tracestate: tracestate ?? null,
    };

    res.setHeader('X-Request-Id', requestId);
    if (traceparent) {
      res.setHeader('traceparent', traceparent);
    }
    if (tracestate) {
      res.setHeader('tracestate', tracestate);
    }

    next();
  };
}
