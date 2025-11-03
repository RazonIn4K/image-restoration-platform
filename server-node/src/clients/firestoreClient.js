import admin from 'firebase-admin';

let initialized = false;

function initialize() {
  if (initialized) return;
  const raw = process.env.FIRESTORE_CREDS;
  if (!raw) {
    throw new Error('Firestore credentials not configured.');
  }
  const creds = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
