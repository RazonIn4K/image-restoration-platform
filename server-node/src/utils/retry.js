function calculateDelay({ baseDelay, attempt, factor, jitter }) {
  const delay = baseDelay * Math.pow(factor, attempt - 1);
  if (!jitter) {
    return delay;
  }
  const jitterValue = delay * jitter;
  const min = delay - jitterValue;
  const max = delay + jitterValue;
  return Math.max(0, min + Math.random() * (max - min));
}

export async function exponentialBackoff({
  attempts = 3,
  minDelayMs = 500,
  factor = 2,
  jitter = 0.3,
  fn,
  onRetry,
}) {
  if (typeof fn !== 'function') {
    throw new TypeError('fn must be a function');
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
      const delay = calculateDelay({
        baseDelay: minDelayMs,
        attempt,
        factor,
        jitter,
      });
      if (onRetry) {
        onRetry(error, { attempt, nextDelayMs: delay });
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
