import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { initializeApp, getApps, getApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Firebase config
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8"));

// Initialize Firebase Admin
const firebaseApp = getApps().length === 0 
  ? initializeApp({
      projectId: firebaseConfig.projectId
    })
  : getApp();

// Use the specific database ID if provided, otherwise default
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId || "(default)");
const auth = getAuth(firebaseApp);

console.log("Firebase Admin initialized with Project ID:", firebaseConfig.projectId);
console.log("Firestore Database ID:", firebaseConfig.firestoreDatabaseId || "(default)");

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API to get minimal interview metadata for the join page
  app.get("/api/interview-metadata/:interviewId", async (req, res) => {
    const { interviewId } = req.params;

    if (!interviewId || interviewId === 'null' || interviewId === 'undefined') {
      return res.status(400).json({ error: "Invalid interview ID" });
    }

    try {
      // Prioritize candidates collection
      const candidateRef = db.collection("candidates").doc(interviewId);
      const candidateSnap = await candidateRef.get();
      
      if (candidateSnap.exists) {
        const data = candidateSnap.data();
        return res.json({
          id: interviewId,
          candidate_name: data?.candidate_name,
          candidate_email: data?.candidate_email,
          applied_role: data?.applied_role,
          status: data?.status === 'interview_completed' ? 'completed' : 'not_started',
          questions_ready: !!(data?.approved_questions && data?.approved_questions.length > 0)
        });
      }

      // Fallback to interviews collection (old flow)
      const interviewRef = db.collection("interviews").doc(interviewId);
      const interviewSnap = await interviewRef.get();

      if (interviewSnap.exists) {
        const data = interviewSnap.data();
        return res.json({
          id: interviewId,
          candidate_name: data?.candidate_name,
          candidate_email: data?.candidate_email,
          applied_role: data?.applied_role,
          status: data?.status,
          questions_ready: !!(data?.approved_questions && data?.approved_questions.length > 0)
        });
      }
      
      return res.status(404).json({ error: "Interview not found" });
    } catch (error) {
      console.error("Metadata error:", error);
      res.status(500).json({ error: "An error occurred while fetching metadata" });
    }
  });

  // API to verify interview and generate a custom token for the candidate
  app.post("/api/verify-interview", async (req, res) => {
    const { identifier, interviewId } = req.body;
    console.log("Verification request for identifier:", identifier, "interviewId:", interviewId);

    if (!identifier) {
      return res.status(400).json({ error: "Interview ID or Email is required" });
    }

    try {
      let interviewData: any = null;
      let finalInterviewId = interviewId || identifier;

      // 1. If interviewId is provided from URL, we MUST match it
      if (interviewId) {
        console.log("Verifying against specific interviewId:", interviewId);
        
        // Try candidates collection first
        const candidateRef = db.collection("candidates").doc(interviewId);
        const candidateSnap = await candidateRef.get();
        if (candidateSnap.exists) {
          const data = candidateSnap.data();
          if (data?.candidate_email?.toLowerCase() === identifier.toLowerCase() || interviewId === identifier) {
            interviewData = data;
            finalInterviewId = interviewId;
          }
        }

        if (!interviewData) {
          // Try interviews collection
          const interviewRef = db.collection("interviews").doc(interviewId);
          const interviewSnap = await interviewRef.get();
          if (interviewSnap.exists) {
            const data = interviewSnap.data();
            if (data?.candidate_email?.toLowerCase() === identifier.toLowerCase() || interviewId === identifier) {
              interviewData = data;
              finalInterviewId = interviewId;
            }
          }
        }
      } else {
        // 2. No interviewId in URL, search by identifier (ID or Email)
        console.log("No interviewId in URL, searching by identifier...");
        
        // Try to find by ID in candidates first
        const candidateRef = db.collection("candidates").doc(identifier);
        const candidateSnap = await candidateRef.get();
        if (candidateSnap.exists) {
          interviewData = candidateSnap.data();
          finalInterviewId = identifier;
        }

        if (!interviewData) {
          // Try interviews collection
          const interviewRef = db.collection("interviews").doc(identifier);
          const interviewSnap = await interviewRef.get();
          if (interviewSnap.exists) {
            interviewData = interviewSnap.data();
            finalInterviewId = identifier;
          }
        }

        // If not found by ID, search by email
        if (!interviewData) {
          const candidatesRef = db.collection("candidates");
          const q2 = candidatesRef.where("candidate_email", "==", identifier.toLowerCase()).limit(1);
          const snapshot2 = await q2.get();
          if (!snapshot2.empty) {
            const doc = snapshot2.docs[0];
            interviewData = doc.data();
            finalInterviewId = doc.id;
          } else {
            const interviewsRef = db.collection("interviews");
            const q = interviewsRef.where("candidate_email", "==", identifier.toLowerCase()).where("status", "!=", "completed").limit(1);
            const snapshot = await q.get();
            if (!snapshot.empty) {
              const doc = snapshot.docs[0];
              interviewData = doc.data();
              finalInterviewId = doc.id;
            }
          }
        }
      }

      if (!interviewData) {
        return res.status(404).json({ error: "Invalid email or link" });
      }

      const storedEmail = interviewData.candidate_email;
      console.log("Generating custom token for email:", storedEmail);

      // Generate a custom token for the candidate
      const customToken = await auth.createCustomToken(`candidate_${finalInterviewId}`, {
        email: storedEmail ? storedEmail.toLowerCase() : "candidate@interviewgenie.local",
        interviewId: finalInterviewId,
        role: "candidate"
      });

      res.json({ 
        token: customToken,
        interview: {
          id: finalInterviewId,
          candidate_name: interviewData.candidate_name,
          candidate_email: storedEmail,
          applied_role: interviewData.applied_role,
          status: interviewData.status,
          questions_approved: interviewData.questions_approved !== false,
        }
      });
    } catch (error: any) {
      console.error("Verification error:", error);
      res.status(500).json({ 
        error: "An error occurred during verification",
        details: error.message 
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: true,
        watch: {}
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
