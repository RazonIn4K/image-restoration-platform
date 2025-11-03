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

- `GEMINI_API_KEY` - Google AI API key for Gemini 2.5 Flash Image
- `FIRESTORE_CREDS` - **Base64-encoded** Firebase service account JSON credentials
- `REDIS_URL` - Redis connection URL (e.g., redis://localhost:6379)
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook endpoint secret
- `NEXT_PUBLIC_API_URL` - Public API URL for CORS configuration
- `LOG_LEVEL` - Logging level (info, debug, error)

**Note:** `FIRESTORE_CREDS` must be base64-encoded. To encode your service account JSON:
```bash
cat service-account.json | base64
```

Running without the Doppler environment will terminate the process and print the missing keys. In CI, provide a Doppler service token via the `DOPPLER_TOKEN` environment variable and execute the same scripts.

### Environment Validation Script

`npm run validate:secrets` executes `server-node/scripts/validate-secrets.js`, which asserts the required secrets exist and recommends using `doppler run --` when they are missing. The Express entrypoint (`src/server.js`) invokes the same check during startup.

## File Upload Validation

Image uploads are accepted only when they meet the following requirements:

- **Field name**: `image`
- **Maximum size**: 10 MB (requests above the limit return `413 Content Too Large` + `Retry-After` header)
- **Allowed formats**: JPEG, PNG, WebP (validated via file magic using `file-type`)
- **Allowed extensions**: `.jpg`, `.jpeg`, `.png`, `.webp`
- **Protection**: Compound extensions (for example `photo.jpg.php`) and unsupported media types return RFC 7807 problem responses

The middleware lives in `src/middleware/uploadValidation.js` and is wired into `POST /v1/jobs` ahead of downstream processing.
