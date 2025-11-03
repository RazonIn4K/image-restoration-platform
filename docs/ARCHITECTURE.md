# System Architecture (Mermaid)

```mermaid
flowchart LR
    subgraph Client
      U[User (Web/PWA/iOS/Android)]
    end

    subgraph WebApp[Frontend - Next.js 14 (PWA + Capacitor)]
      UI[Upload UI + Prompt (optional)]
      UI -->|HTTPS| API
    end

    subgraph Edge[API Gateway]
      API[Express/FastAPI]
      RL[Redis Token Bucket\nRate Limiter]
      AUTH[Firebase Auth]
      API --> RL
      API --> AUTH
    end

    subgraph Jobs[Async Queue]
      Q[Bull (Node) / Celery (Py)]
      W[Workers: Gemini calls,\npre/post processing]
      Q --> W
    end

    subgraph Data[Data & Storage]
      DB[(Firestore:\nusers, credits, jobs, logs)]
      RDS[(Redis:\nrates, sessions, cache)]
      ST[(Cloud Storage/S3:\noriginals & outputs)]
    end

    subgraph AI[Model Layer]
      GEM[Gemini 2.5 Flash Image\n(“Nano‑Banana”)]
    end

    subgraph Billing[Billing]
      STR[Stripe: subs + credits]
    end

    U --> UI
    UI --> API
    API -->|enqueue| Q
    W -->|read/write| ST
    W -->|log| DB
    W -->|restore/fuse| GEM
    API --> DB
    API --> RDS
    API --> STR
    UI <-->|realtime status| DB
    UI -->|download| ST
```

**Notes**  
- Multi‑image blending and character consistency are supported by Gemini 2.5 Flash Image; pricing ≈ $0.039 per 1024×1024 image and ten aspect ratios are available (Oct 2025 update). These are the assumptions used in our plan.  
- See the slides + long guide in the repo for the full build, limits and defaults.
