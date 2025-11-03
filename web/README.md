# Web App (Next.js 14 PWA)

## Create scaffolding
npx create-next-app@latest webapp --ts --eslint --tailwind --src-dir --app --import-alias "@/*"

## PWA
- Add `manifest.json`, icons, and service worker.
- Use the Next.js `app/` router and the Image component.
- Point `NEXT_PUBLIC_API_URL` to your Node or Python API.

## Camera/File input
- Simple: `<input type="file" accept="image/*" capture="environment" multiple />`
- Or wrap with Capacitor for native iOS/Android.
