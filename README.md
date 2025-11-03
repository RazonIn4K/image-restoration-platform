# AI Image Restoration Platform

Production-ready foundation for a web + mobile (PWA) platform that:
- Restores single images with smart defaults
- Supports optional custom prompts
- Blends up to 3 images (premium/credits)
- Tracks daily free use + paid credits/subscriptions

**Core docs**  
- Slides: `answer.pptx` (quick overview of scope/plan).  :contentReference[oaicite:2]{index=2}
- Implementation Guide: `image-restoration-platform.md` (full build spec).  :contentReference[oaicite:3]{index=3}
- Architecture + Mermaid: `docs/ARCHITECTURE.md`.

## Get started
Choose a backend:
- **Node/Express**: `server-node/`  
- **Python/FastAPI**: `server-python/`

See `web/README.md` to scaffold a Next.js 14 PWA.

## Key features
- Degradation classification → meta-prompting → restoration
- Multi-image fusion (≤3 images/call)
- Credits + rate limiting (2–3 free/day, then Stripe)
- Queue workers for async image jobs
