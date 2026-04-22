import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, firebaseConfig.firestoreDatabaseId);

// Note: Do not attempt a forced read of a protected document at startup.
// Firestore rules commonly require authentication or ownership for reads/writes,
// which would cause a noisy "Missing or insufficient permissions" error in the
// console during app initialization. If you need an explicit connectivity test,
// do it after the user signs in or use a dedicated public document designed
// for health checks.
console.log("Firestore initialized for project:", firebaseConfig.projectId);
