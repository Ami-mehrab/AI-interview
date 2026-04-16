import React, { useState, useEffect } from "react";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import {
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  onAuthStateChanged,
} from "firebase/auth";
import { db, auth } from "../lib/firebase";
import { motion, AnimatePresence } from "framer-motion";
import {
  User,
  LogIn,
  Loader2,
  Clock,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";

interface CandidateGateProps {
  id: string;
  onSuccess: (interviewData: any) => void;
}

export const CandidateGate: React.FC<CandidateGateProps> = ({
  id,
  onSuccess,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [interviewData, setInterviewData] = useState<any>(null);
  const [isVerified, setIsVerified] = useState(false);
  const [hasTriggeredSuccess, setHasTriggeredSuccess] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (isVerified && id && !hasTriggeredSuccess) {
      const unsubscribe = onSnapshot(doc(db, "candidates", id), (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          setInterviewData(data);

          const now = Date.now();
          const expiresAt = data.window_expires_at?.toMillis?.() || 0;
          const isActiveSession =
            data.session_status === "open" ||
            data.session_status === "in-progress";
          const isWithinWindow = now < expiresAt;

          if (isActiveSession && isWithinWindow) {
            setHasTriggeredSuccess(true);
            onSuccess({ id: docSnap.id, ...data });
          }
        }
      });
      return () => unsubscribe();
    }
  }, [isVerified, id, onSuccess, hasTriggeredSuccess]);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    const provider = new GoogleAuthProvider();

    try {
      const result = await signInWithPopup(auth, provider);
      const userEmail = result.user.email;

      if (!userEmail) {
        throw new Error("Could not retrieve email from Google account.");
      }

      const docRef = doc(db, "candidates", id);
      const docSnap = await getDoc(docRef);

      if (!docSnap.exists()) {
        await signOut(auth);
        setError("Invalid interview link.");
        return;
      }

      const data = docSnap.data();

      if (userEmail.toLowerCase() !== data.candidate_email?.toLowerCase()) {
        await signOut(auth);
        setError(
          "Access Denied: This Google account is not authorized for this interview.",
        );
        return;
      }

      setInterviewData(data);
      setIsVerified(true);
    } catch (err: any) {
      console.error("Authentication/Verification error:", err);
      setError(err.message || "An error occurred during verification.");
    } finally {
      setLoading(false);
    }
  };
  if (isVerified && interviewData) {
    const now = Date.now();
    const expiresAt = interviewData.window_expires_at?.toMillis?.() || 0;

    // ✅ ADD THE COMPLETION CHECK
    const isCompleted =
      interviewData.status === "completed" ||
      interviewData.status === "interview_completed" ||
      interviewData.session_status === "completed";

    // Prevent pending/expired states from overriding a completed interview
    const isExpired =
      !isCompleted &&
      (interviewData.session_status === "expired" ||
        (interviewData.session_status === "open" && now >= expiresAt));
    const isPending =
      !isCompleted && interviewData.session_status === "pending";

    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-white p-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 text-center space-y-6 shadow-2xl"
        >
          {/*  SHOW THE COMPLETED UI FIRST */}
          {isCompleted ? (
            <>
              <div className="w-20 h-20 bg-emerald-500/10 rounded-2xl flex items-center justify-center mx-auto text-emerald-500 shadow-inner">
                <CheckCircle2 className="w-10 h-10" />
              </div>
              <div className="space-y-2">
                <h3 className="text-2xl font-bold tracking-tight">
                  Interview Completed
                </h3>
                <p className="text-sm text-slate-400">
                  You have already successfully completed this interview. Your
                  responses have been saved and are under review by the
                  recruiting team.
                </p>
              </div>
              <div className="pt-4 border-t border-slate-800">
                <p className="text-[10px] text-slate-500 uppercase tracking-widest">
                  You may safely close this window
                </p>
              </div>
            </>
          ) : isPending ? (
            <>
              <div className="w-20 h-20 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto text-blue-500">
                <Clock className="w-10 h-10 animate-pulse" />
              </div>
              <div className="space-y-2">
                <h3 className="text-2xl font-bold tracking-tight">
                  Waiting Room
                </h3>
                <p className="text-sm text-slate-400">
                  Waiting for Recruiter to start your interview...
                </p>
              </div>
              <div className="pt-4 border-t border-slate-800">
                <p className="text-[10px] text-slate-500 uppercase tracking-widest">
                  Please keep this window open
                </p>
              </div>
            </>
          ) : isExpired ? (
            <>
              <div className="w-20 h-20 bg-red-500/10 rounded-2xl flex items-center justify-center mx-auto text-red-500">
                <AlertCircle className="w-10 h-10" />
              </div>
              <div className="space-y-2">
                <h3 className="text-2xl font-bold tracking-tight">
                  Link Expired
                </h3>
                <p className="text-sm text-slate-400">
                  The 48-hour joining window has expired. Please contact your
                  recruiter for a new link.
                </p>
              </div>
              <button
                onClick={() => window.location.reload()}
                className="w-full py-4 bg-slate-800 hover:bg-slate-700 rounded-2xl font-bold transition-all"
              >
                Refresh Page
              </button>
            </>
          ) : (
            <>
              <div className="w-20 h-20 bg-green-500/10 rounded-2xl flex items-center justify-center mx-auto text-green-500">
                <Loader2 className="w-10 h-10 animate-spin" />
              </div>
              <div className="space-y-2">
                <h3 className="text-2xl font-bold tracking-tight">
                  Joining Session...
                </h3>
                <p className="text-sm text-slate-400">
                  The recruiter has opened the session. Connecting you now.
                </p>
              </div>
            </>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-white p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 text-center space-y-6 shadow-2xl"
      >
        <div className="w-20 h-20 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto text-blue-500">
          <User className="w-10 h-10" />
        </div>

        <div className="space-y-2">
          <h3 className="text-2xl font-bold tracking-tight">
            Welcome to your Interview
          </h3>
          <p className="text-sm text-slate-400">
            Please sign in with your registered Google account to begin.
          </p>
        </div>

        <div className="space-y-4">
          {error && (
            <p className="text-xs text-red-400 bg-red-400/10 p-4 rounded-xl border border-red-400/20 leading-relaxed">
              {error}
            </p>
          )}

          <button
            onClick={handleSignIn}
            disabled={loading}
            className="w-full py-4 bg-white text-slate-950 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed rounded-2xl font-bold flex items-center justify-center gap-3 transition-all shadow-lg shadow-white/5"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
            )}
            Sign in with Google to Join
          </button>
        </div>

        <div className="pt-4 border-t border-slate-800">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest">
            Secure Interview Session
          </p>
        </div>
      </motion.div>
    </div>
  );
};
