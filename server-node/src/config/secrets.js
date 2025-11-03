const REQUIRED_SECRETS = [
  'GEMINI_API_KEY',
  'FIRESTORE_CREDS',
  'REDIS_URL',
  'STRIPE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_API_URL',
  'LOG_LEVEL'
];

function detectMissingSecrets(env = process.env) {
  return REQUIRED_SECRETS.filter((key) => {
    const value = env[key];
    return value === undefined || value === null || String(value).trim() === '';
  });
}

export function assertRequiredSecrets({ env = process.env, exitOnError = true } = {}) {
  const missing = detectMissingSecrets(env);

  if (missing.length === 0) {
    return true;
  }

  const header = '\n[config] Missing required secrets:';
  console.error(header, missing.join(', '));
  if (!env.DOPPLER_PROJECT && !env.DOPPLER_ENVIRONMENT) {
    console.error(
      '[config] Doppler context not detected. Run commands using `doppler run -- <command>` to inject secrets.'
    );
  }

  if (exitOnError) {
    process.exitCode = 1;
    process.exit(1);
  }

  return false;
}

export function listRequiredSecrets() {
  return [...REQUIRED_SECRETS];
}
