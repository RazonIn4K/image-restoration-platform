# Implementation Guide (Index)

- Slides summary: `answer.pptx` (overview)  
- Full walkthrough: `image-restoration-platform.md` (detailed build plan)

This repository implements that plan. Track deltas from upstream docs here as we iterate.

## Doppler Secrets Management

All backend processes must run through Doppler so that secrets are never read from disk. Install the Doppler CLI and authenticate:

```bash
doppler login
doppler setup --project ai-restoration-similar --config dev
```

Run every Node command using the Doppler wrapper scripts defined in `server-node/package.json`:

```bash
# Development server
npm run dev:doppler

# Production-like start
npm run start:doppler

# Secret validation utility
npm run validate:secrets:doppler
```

### Required Secrets

The Express backend validates the presence of these secrets on startup:

- `GEMINI_API_KEY`
- `FIRESTORE_CREDS`
- `REDIS_URL`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_API_URL`
- `LOG_LEVEL`

Running without the Doppler environment will terminate the process and print the missing keys. In CI, provide a Doppler service token via the `DOPPLER_TOKEN` environment variable and execute the same scripts.

### Environment Validation Script

`npm run validate:secrets` executes `server-node/scripts/validate-secrets.js`, which asserts the required secrets exist and recommends using `doppler run --` when they are missing. The Express entrypoint (`src/server.js`) invokes the same check during startup.
