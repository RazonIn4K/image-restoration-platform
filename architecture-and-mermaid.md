# AI Image Restoration Platform: Full Architecture

This document builds upon the implementation guide and slides to provide a clear, comprehensive architecture for your AI-powered image restoration platform.  The architecture integrates a React/Next.js Progressive Web App with a Firebase backend, an asynchronous job queue, third‑party AI services, and payment processing.  A Mermaid diagram depicts how these components interact.

## High‑Level Overview

The platform is designed around four layers:

1. **Frontend layer** – A React 18 app built with Next.js 14, styled using Tailwind CSS and Shadcn/UI, which serves both as a web application and as a mobile application via Capacitor.  This layer handles file uploads, user input (optionally including custom prompts), display of before/after results, and communicates with the backend via authenticated API requests.
2. **API gateway layer** – An Express (Node.js) or FastAPI (Python) server that validates requests, authenticates users via Firebase Auth, handles CORS and security headers, and forwards image restoration tasks to a job queue.  It also exposes endpoints for subscription management and credit deduction via Stripe.
3. **Services layer** – This comprises the asynchronous job queue (Bull or Celery) for processing requests, the AI models (Gemini 2.5 Flash Image for text‑and‑image restoration and multi‑image fusion【418255494491571†L152-L155】), and third‑party services like Stripe for payment processing.  Jobs fetch images from storage, call the AI API with the correct prompt and parameters, store the result back into storage, and update Firestore with the outcome.
4. **Data layer** – A serverless backend built on Firestore for user accounts and credit tracking, Redis for caching and real‑time rate limiting, and Google Cloud Storage (GCS) or S3 for storing uploaded and processed images.  Firestore transactions ensure atomic credit deductions, while Redis implements a token‑bucket algorithm to enforce per‑user limits.

### Data Flow

1. **Upload & request**: The user uploads an image (or images) via the frontend.  The client performs basic validation (file type, size) and sends the file(s) to the API gateway along with the user’s prompt (if any) and authentication token.
2. **Validation & queuing**: The API gateway validates the authentication token, checks the user’s credit balance and rate limits, writes an initial restoration record to Firestore, saves the uploaded files to temporary storage, and enqueues a job in the message queue.
3. **Processing**: A worker picks up the job from the queue, reads the image from storage, runs degradation classification to determine the type of restoration needed, enhances the prompt if provided, calls the Gemini 2.5 Flash Image API for restoration or multi‑image fusion, and stores the result back in storage.
4. **Update & notify**: The worker updates Firestore with the result, deducts credits atomically, and sends a notification to the frontend via WebSocket or polling.  The API can also use Firebase Cloud Messaging for push notifications when processing completes.

5. **Subscription & payments**: When a user upgrades to a paid plan, the frontend opens a Stripe Checkout session.  Stripe webhooks notify the backend of subscription events (e.g., payment succeeded, subscription cancelled), and the backend updates Firestore with the new subscription status and credit allowances.

## Mermaid Diagram

The following Mermaid flowchart illustrates the core architecture of the platform.  It shows how the frontend communicates with the API gateway, how tasks are queued and processed, and how storage and databases interact with AI services and payment processing.

```mermaid
flowchart TD
    %% Frontend layer
    subgraph Frontend
        FE[React/Next.js PWA & Capacitor]
    end

    %% API gateway layer
    subgraph API_Gateway
        API[API Gateway\nExpress / FastAPI]
    end

    %% Service layer
    subgraph Services
        Queue[Job Queue\n(Bull/Celery)]
        Gemini[Gemini 2.5 Flash Image\n(Nano‑Banana)]
        Stripe[Stripe API\n(Payments)]
    end

    %% Data layer
    subgraph Data
        Firestore[Firestore\n(Auth, Users, Credits)]
        Redis[Redis\n(Rate limiting, cache)]
        Storage[GCS/S3\n(Image storage)]
    end

    FE -->|HTTPS requests\nwith auth tokens| API
    API -->|Enqueue job| Queue
    API -->|Update user & credits| Firestore
    API -->|Rate limiting| Redis
    API -->|Store uploaded files| Storage
    API -->|Process payments| Stripe

    Queue -->|Restore images| Gemini
    Queue -->|Write results| Storage
    Queue -->|Credit update| Firestore
    Queue -->|Cache| Redis

    Stripe -- Subscription events --> API
    Firestore -- Auth tokens & user data --> API
    Storage -- Temporary images --> Queue

    %% Legend for multi‑image fusion
    note over FE, Gemini: For premium users, up to three images per request can be blended into a single output【418255494491571†L152-L155】.
```

## Explanation

This flowchart depicts the interactions among the platform’s components:

1. **Frontend** – Users interact with a responsive React/Next.js application that supports progressive web app (PWA) features and can be wrapped for mobile using Capacitor.  The frontend authenticates users (via Firebase Auth tokens), handles file uploads, and receives real‑time updates about job status.
2. **API Gateway** – This layer, implemented in Express or FastAPI, validates inputs, ensures that rate limits are respected (using Redis) and that users have sufficient credits (stored in Firestore).  It persists uploaded images to GCS/S3, enqueues the processing job in the message queue, and proxies payment events to Stripe for subscription management.
3. **Job Queue & Services** – The job queue (Bull or Celery) decouples request handling from the heavy lifting of image restoration.  Workers consume jobs asynchronously, run degradation classification and meta‑prompting pipelines, call the Gemini 2.5 Flash Image API to restore or blend images, and save the output back to storage.  Stripe is used for billing; its webhooks notify the API about subscription changes so that credit allowances can be updated.
4. **Data & Storage** – Firestore maintains user accounts, credit balances, subscription status, and logs of restorations.  Redis caches frequent lookups (like remaining credits) and implements token‑bucket rate limiting.  GCS or S3 temporarily stores uploaded and processed images; workers clean up temporary files when finished.

This architecture supports high concurrency via asynchronous processing and horizontal scalability in both the API gateway and job workers.  It leverages serverless or managed services (Firestore, Redis, GCS) for reliability and integrates with Stripe for monetization.  The modular design also allows adding alternative AI models (e.g., GFPGAN or CodeFormer) as separate services in the future.

## Conclusion

The platform’s architecture emphasizes separation of concerns, scalability, and user experience.  By blending serverless technologies for data storage and caching with asynchronous job processing and AI services, the platform delivers low latency and high reliability.  The mermaid diagram above provides a visual reference to guide implementation, and the layers described here align with the accompanying implementation guide and slide deck.