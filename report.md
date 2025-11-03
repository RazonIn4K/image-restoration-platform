# Building a SaaS platform for AI‑powered photo restoration (updated guidance, November 2025)

## 1 Validation of key model assumptions

### Gemini 2.5 Flash Image availability and pricing

* **Model capabilities** – The 2025 update of Gemini 2.5 Flash Image (code‑named **nano‑banana**) allows you to combine multiple input images, preserve consistent characters across scenes, make targeted edits with natural‑language prompts and use the model’s world knowledge for sophisticated image generation【173439411997390†screenshot】.  These abilities are highlighted in Google’s developer blog: the model “enables you to blend multiple images into a single image, maintain character consistency for rich storytelling, [and] make targeted transformations using natural language”【173439411997390†screenshot】.  Additional sections emphasise that it can **understand and merge multiple input images** for applications such as placing an object into a new scene or fusing images with one prompt【482756761672557†screenshot】.  It also supports **prompt‑based image editing** where users can blur backgrounds, remove objects or colorize black‑and‑white photos using plain language【239679121219991†screenshot】.
* **Aspect‑ratio support** – In October 2025 Google announced that Gemini 2.5 Flash Image supports ten aspect ratios (21:9, 16:9, 4:3, 3:2, 1:1, 9:16, 3:4, 2:3, 5:4 and 4:5)【451390663676525†L160-L171】.  This feature allows you to generate outputs tailored for widescreen, square or vertical formats.
* **Pricing and token usage** – According to the official pricing guide, the model costs **$30 per million output tokens**, which equates to about **$0.039 per generated image** (because each 1024×1024 image consumes ~1 290 output tokens)【173439411997390†screenshot】【451390663676525†L233-L235】.
* **Rate limits and free tier** – Google’s rate‑limit table shows that the free Tier 0 limit for **Gemini 2.5 Flash** (text‑output) is **250 requests per day (RPD)** and **10 RPM**【162539542798489†L218-L223】, while **Gemini 2.5 Flash‑Lite** offers **1 000 RPD** in the free tier【162539542798489†L221-L223】.  For the image‑generation model, **Gemini 2.5 Flash Image** is in Tier 1 and allows **2 000 RPD** and 500 RPM【162539542798489†L244-L262】—it does **not** have a 1 000‑per‑day free quota.  Therefore the claim of a “1 000 free requests/day” limit is not supported by official documentation.  Using the model at scale requires a billing account.

### Performance claims (speed and cost)

Some third‑party blogs report that Gemini 2.5 Flash Image has **2× the latency** and is **40 % cheaper** than Gemini Pro Vision.  These figures come from non‑Google sources and are not corroborated in Google’s documentation.  In general, Flash models are designed for speed and cost efficiency, but you should not market a specific “2× faster/40 % cheaper” figure without verifying it directly with Google’s benchmarks or your own testing.

## 2 Design considerations and improvements

### 2.1 Multi‑stage prompt enhancement and degradation detection

Research on vision‑language models shows that automatically classifying an input image’s degradation type improves restoration quality.  An arXiv paper from June 2025 proposes using a Vision‑Language Model to **categorize degraded images** into four types—super‑resolution degradation, reflection artifacts, motion blur or no visible degradation—and to **apply targeted restoration** models accordingly【790066568935268†L49-L58】.  Implementing such a **degradation‑detection step** before generating prompts can help your system select the right default instructions (e.g., denoising, colorization or inpainting).  A possible approach is:

1. **Degradation classification** – Use Gemini 2.5 Flash Image’s vision understanding to classify the uploaded image into degradation categories (noise/blur/compression, reflections, motion blur, or high quality) as described in the research【790066568935268†L49-L58】.
2. **Meta‑prompting** – Feed the user’s prompt and the degradation info into a **text‑only Gemini 2.5 Flash** model to produce an enhanced, detailed restoration prompt.  For example, “remove scratches” could become “inpaint the scratch on the child’s cheek seamlessly, matching skin tones, and colorize the blue vest vividly.”  This step ensures that the image‑editing model receives a high‑quality, context‑aware instruction.
3. **Image editing or fusion** – Pass the enhanced prompt along with the image(s) to the `gemini-2.5-flash-image` model.  For multi‑image requests, explain how to combine them (e.g., “place the object from image 1 into the scene of image 2 and harmonize lighting”).  The official blog notes that the model can **blend multiple input images** and maintain consistent characters for storytelling【173439411997390†screenshot】【482756761672557†screenshot】.

### 2.2 Bulk processing and chunking

Gemini 2.5 Flash Image accepts up to three input images per call【451390663676525†L160-L171】, so your backend should **chunk batches** accordingly.  For a bulk restoration feature:

* **Single‑image restoration** – Default path; each upload triggers one API call.
* **Multi‑image fusion** – If users want to combine images, group up to three at a time; call the API with a descriptive merge prompt (e.g., “restore each photo individually and merge them into a coherent family portrait”).  Process additional images in subsequent batches.

You can implement a queue (e.g., Bull MQ or Celery) to process jobs asynchronously and to scale horizontally across workers.

### 2.3 Rate limiting, credits and retries

* **Server‑side rate limiting** – Rate limiting protects your backend from burst traffic and helps avoid 429 (“resource exhausted”) errors.  GeeksforGeeks explains that rate limiting controls how quickly a system processes incoming requests and limits the request rate to prevent overload and ensure fair distribution of resources【134662112016714†screenshot】.  Implement per‑user limits (e.g., 3 free images/day) using a distributed store like Redis; update quotas atomically and cache results for performance.  For multiple workers, use a central data store (Firestore or PostgreSQL) plus Redis caching to coordinate credit consumption.
* **Error handling** – Google’s product‑expert answer on the Gemini Apps forum notes that free‑tier users can hit hidden burst limits if they send many requests in a tight loop.  The expert recommends introducing **rate limiting on your end** (using “leaky bucket” or “token bucket” algorithms) and using **retry logic with exponential backoff** for 429 errors【851426460098141†screenshot】.  In practice, when you receive a 429, wait a short time before retrying; if the error persists, increase the delay.  Combining retries with jitter prevents synchronized retries from causing further spikes.

### 2.4 Image preprocessing

Before sending images to the API, downsize and compress them to reduce token usage and cost.  Gemini 2.5 Flash Image counts both input and output tokens; resizing large images (e.g., limiting maximum dimension to 2 000 px and compressing to high‑quality JPEG) can cut token usage significantly without major quality loss.  Use libraries such as Sharp (Node.js) or Pillow (Python) for this step.

### 2.5 Admin panel and analytics

* **User management** – Track sign‑ups, subscription status, daily credit usage and history.  Provide tools to adjust credits manually and to deactivate abusive users.
* **Job monitoring** – Display the number of active/failing jobs, average processing time and API costs.  Keep an audit trail of credit adjustments and account actions.  If your queue provides a dashboard (Bull Arena, Celery Flower), embed it in your admin panel.
* **Content moderation** – Because Gemini applies an invisible SynthID watermark, your platform is responsible for filtering harmful content and prompts.  Implement a moderation queue for images and prompts that are flagged by Google’s safety filters or your own keyword check.

### 2.6 Front‑end and mobile options

* **Responsive web app** – Build the UI with React or Next.js; use the `<input type="file">` element to support uploads from desktop or mobile.  With service workers, convert it into a **Progressive Web App (PWA)** that installs on a mobile home screen.  PWA plus Capacitor can access the camera and file system without rewriting the app.
* **Native wrapper** – If deeper mobile integration or in‑app purchases are needed, wrap the PWA using Capacitor or build a React Native client that communicates with the same backend.

## 3 Updated development roadmap

| Week | Milestones |
|-----:|------------|
| **Week 1** | *Backend scaffold:* Set up Node.js/Express or Python/FastAPI backend; configure Gemini SDK and image‑preprocessing pipeline.  Implement sign‑up/login and store user quotas in Firestore or MongoDB.  *Basic restoration:* Build a `/restore` endpoint that accepts one image and an optional prompt, generates a default or enhanced prompt and calls the API.  *Front‑end skeleton:* Create a minimal React UI with image upload and result display. |
| **Week 2** | *Enhancements:* Add degradation‑classification and meta‑prompting.  Implement multi‑image upload and chunking.  Connect Stripe for subscriptions and track credits.  *Admin dashboard:* Include usage analytics, credit adjustments and job monitoring.  *Mobile:* Wrap the web app with Capacitor for PWA deployment.  *Testing and refinement:* Use sample degraded photos to iterate on prompt templates and verify that rate limiting and retries handle 429 errors gracefully. |

## 4 Key takeaways

* **Gemini 2.5 Flash Image** (Nano‑Banana) is a versatile model for restoration and editing.  It can blend multiple input images, maintain character consistency and perform localized edits based on natural‑language prompts【173439411997390†screenshot】【239679121219991†screenshot】.
* **Rate limits** – Official documentation lists 250 RPD for Gemini 2.5 Flash (text) and 2 000 RPD for Gemini 2.5 Flash Image in Tier 1; there is no 1 000 RPD free tier for the image model【162539542798489†L218-L223】【162539542798489†L244-L262】.  Misstating quotas can mislead users about cost and performance.
* **Prompt engineering** – Use a two‑stage approach: automatically classify degradation type and then meta‑prompt to enhance the user’s instructions.  This technique draws on research showing that VLM‑based classification followed by tailored restoration improves quality【790066568935268†L49-L58】.
* **System design** – Protect your service with server‑side rate limiting, credit tracking and exponential backoff retries.  Official forum guidance emphasises introducing client‑side delay and exponential backoff when encountering 429 errors【851426460098141†screenshot】, while system‑design tutorials describe rate limiting as a technique to prevent overload and ensure fair resource usage【134662112016714†screenshot】.
* **User experience** – Provide both a simple workflow (one image, auto‑restoration) and a premium experience (custom prompts, multi‑image fusion, higher resolution).  A responsive web app, optionally wrapped as a PWA or native app, maximizes accessibility.

By incorporating these evidence‑based refinements into your project plan, you’ll deliver a robust and user‑friendly photo‑restoration platform that leverages the latest advances in multimodal AI while respecting rate limits and cost constraints.
