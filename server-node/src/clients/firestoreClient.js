import admin from 'firebase-admin';

let initialized = false;

function initialize() {
  if (initialized) return;
  const raw = process.env.FIRESTORE_CREDS;
  if (!raw) {
    throw new Error('Firestore credentials not configured.');
  }
  
  // Decode base64-encoded credentials from Doppler
  let creds;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    creds = JSON.parse(decoded);
  } catch (error) {
    // Fallback: try parsing as raw JSON for development
    try {
      creds = JSON.parse(raw);
    } catch (fallbackError) {
      throw new Error(`Failed to parse FIRESTORE_CREDS: ${error.message}`);
    }
  }
  
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(creds),
    });
  }
  initialized = true;
}

export class FirestoreClient {
  constructor() {
    initialize();
    this.db = admin.firestore();
  }

  collection(name) {
    return this.db.collection(name);
  }

  async setDoc(path, data) {
    const [collection, doc] = path.split('/');
    return this.collection(collection).doc(doc).set(data, { merge: true });
  }
}

export function createFirestoreClient() {
  try {
    return new FirestoreClient();
  } catch (error) {
    console.warn('[firestore] Using mock client:', error.message);
    return {
      collection: () => ({ doc: () => ({ set: async () => {} }) }),
      setDoc: async () => {},
    };
  }
}
