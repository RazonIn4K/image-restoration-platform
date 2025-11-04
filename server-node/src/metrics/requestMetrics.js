const MAX_SAMPLES = Number(process.env.HEALTH_METRIC_SAMPLE_SIZE ?? 1000);
const samples = [];

export function recordRequestDuration(durationMs) {
  if (!Number.isFinite(durationMs)) {
    return;
  }

  samples.push(durationMs);
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }
}

export function getRequestMetrics() {
  const count = samples.length;
  if (count === 0) {
    return {
      count: 0,
      averageMs: 0,
      p95Ms: 0,
    };
  }

  const sum = samples.reduce((acc, value) => acc + value, 0);
  const averageMs = sum / count;

  const sorted = [...samples].sort((a, b) => a - b);
  const p95Index = Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)));
  const p95Ms = sorted[p95Index];

  return {
    count,
    averageMs,
    p95Ms,
  };
}
