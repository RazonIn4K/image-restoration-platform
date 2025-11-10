import { recordRequestDuration } from '../metrics/requestMetrics.js';

export function requestTiming() {
  return (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1e6;
      recordRequestDuration(durationMs);
    });

    next();
  };
}
