# Doppler Backend Infrastructure Spec

This workspace records configuration metadata for the Doppler-managed secrets used by the Express backend. Each environment (development, staging, production) maps to a Doppler config. Required secret keys:

- `GEMINI_API_KEY`
- `FIRESTORE_CREDS`
- `REDIS_URL`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_API_URL`
- `LOG_LEVEL`

All CLI commands must be executed via `doppler run --` to inject these secrets.
