import admin from 'firebase-admin';
import { createProblem } from '../utils/problem.js';

let appInitialized = false;
let useMockAuth = false;

function initializeFirebase() {
  if (appInitialized || useMockAuth) {
    return;
  }

  const rawCreds = process.env.FIRESTORE_CREDS;
  if (!rawCreds) {
    useMockAuth = true;
    return;
  }

  try {
    // Decode base64-encoded credentials from Doppler
    let creds;
    try {
      const decoded = Buffer.from(rawCreds, 'base64').toString('utf-8');
      creds = JSON.parse(decoded);
    } catch (error) {
      // Fallback: try parsing as raw JSON for development
      creds = JSON.parse(rawCreds);
    }
    
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(creds),
      });
    }
    appInitialized = true;
  } catch (error) {
    console.error('[auth] Failed to initialize Firebase Admin SDK. Falling back to mock auth.', {
      error: error?.message,
    });
    useMockAuth = true;
  }
}

function verifyMockToken(token) {
  if (!token.startsWith('dev-user-')) {
    throw new Error('Invalid mock token');
  }

  const [, , userId] = token.split('-');
  return {
    uid: userId ?? 'mock-user',
    email: `${userId ?? 'mock-user'}@example.dev`,
    email_verified: true,
    token_source: 'mock',
  };
}

export function firebaseAuth({ optional = false, authorize } = {}) {
  initializeFirebase();

  const isAuthorized =
    authorize ?? ((decodedToken) => (decodedToken.email_verified ?? true) !== false);

  return async function firebaseAuthMiddleware(req, _res, next) {
    const authHeader = req.header('Authorization');
    if (!authHeader) {
      if (optional) {
        return next();
      }
      return next(
        createProblem({
          type: 'https://docs.image-restoration.ai/problem/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Missing Authorization header.',
        })
      );
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return next(
        createProblem({
          type: 'https://docs.image-restoration.ai/problem/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Malformed Authorization header.',
        })
      );
    }

    const token = match[1].trim();

    try {
      const decoded = useMockAuth
        ? verifyMockToken(token)
        : await admin.auth().verifyIdToken(token, true);

      if (!isAuthorized(decoded)) {
        return next(
          createProblem({
            type: 'https://docs.image-restoration.ai/problem/forbidden',
            title: 'Forbidden',
            status: 403,
            detail: 'The authenticated user does not have access to this resource.',
          })
        );
      }

      req.user = {
        id: decoded.uid,
        email: decoded.email,
        claims: decoded,
      };
      req.context = {
        ...(req.context ?? {}),
        userId: decoded.uid,
      };

      return next();
    } catch (error) {
      return next(
        createProblem({
          type: 'https://docs.image-restoration.ai/problem/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Invalid or expired bearer token.',
          extras: {
            reason: error?.code ?? error?.message,
          },
        })
      );
    }
  };
}
