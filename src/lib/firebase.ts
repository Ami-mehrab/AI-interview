import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore, getDocFromServer, doc } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, firebaseConfig.firestoreDatabaseId);

// Test connection
async function testConnection() {
  try {
    console.log("Testing Firestore connection to project:", firebaseConfig.projectId);
    await getDocFromServer(doc(db, '_test_connection_', 'init'));
    console.log("Firestore connection test successful.");
  } catch (error) {
    console.error("Firestore connection test failed:", error);
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("The client is offline. This often means the Project ID or API Key is incorrect, or the Firestore API is not enabled for the project.");
    }
  }
}
testConnection();
