import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Square, Bot, User, MessageSquare, Loader2, Play, CheckCircle2, Camera } from 'lucide-react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { db, auth } from '../lib/firebase';
import { doc, updateDoc, setDoc, arrayUnion, serverTimestamp, getDoc } from 'firebase/firestore';

const WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
constructor(options) {
super();
this.sourceRate = options.processorOptions.sampleRate || 48000;
this.targetRate = 16000;
this.buffer = new Float32Array(4096);
this.bufferIdx = 0;
}
process(inputs) {
const input = inputs[0]; if (!input || !input.length) return true;
const channel = input[0];
const ratio = this.sourceRate / this.targetRate;
const outputSamples = Math.floor(channel.length / ratio);
for (let i = 0; i < outputSamples; i++) {
const start = Math.floor(i * ratio); const end = Math.floor((i + 1) * ratio);
let sum = 0; let count = 0;
for (let j = start; j < end && j < channel.length; j++) { sum += channel[j]; count++; }
const sample = count > 0 ? sum / count : 0;
if (this.bufferIdx < this.buffer.length) this.buffer[this.bufferIdx++] = sample;
else { this.flush(); this.buffer[this.bufferIdx++] = sample; }
}
if (this.bufferIdx >= 512) this.flush();
return true;
}
flush() {
if (this.bufferIdx === 0) return;
const pcmData = new Int16Array(this.bufferIdx);
for (let i = 0; i < this.bufferIdx; i++) {
let s = Math.max(-1, Math.min(1, this.buffer[i]));
pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
}
this.port.postMessage(pcmData); this.bufferIdx = 0;
}
}
registerProcessor('pcm-processor', PCMProcessor);
`;

import { float32ToPcm, uint8ArrayToBase64, base64ToUint8Array } from '../lib/audio-utils';

interface InterviewSessionProps {
  candidateData: any;
  onComplete?: () => void;
}

export const InterviewSession: React.FC<InterviewSessionProps> = ({ candidateData, onComplete }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [transcript, setTranscript] = useState<{ speaker: string, text: string }[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isCompleted, setIsCompleted] = useState(false);
  const [hasEverConnected, setHasEverConnected] = useState(false);
  const [hasPermissions, setHasPermissions] = useState(false);
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [questionCount, setQuestionCount] = useState(0);

  const [isSaving, setIsSaving] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const audioQueueRef = useRef<Int16Array[]>([]);
  const isPlayingRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const hasEverConnectedRef = useRef(false);
  const transcriptRef = useRef<any[]>([]);

  // Sync video stream to video element whenever it might have remounted
  useEffect(() => {
    if (videoRef.current && localStreamRef.current) {
      videoRef.current.srcObject = localStreamRef.current;
    }
  }, [hasPermissions, isConnected]);

  // Automatic Photo Capture (Anti-Cheat)
  const captureCandidatePhoto = async () => {
    if (videoRef.current && canvasRef.current && candidateData.id) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const photoBase64 = canvas.toDataURL('image/jpeg', 0.8);
        
        try {
          await updateDoc(doc(db, 'candidates', candidateData.id), {
            candidate_photo_base64: photoBase64,
            updated_at: serverTimestamp()
          });
          console.log("Candidate photo captured and saved.");
        } catch (error) {
          console.error("Failed to save candidate photo:", error);
        }
      }
    }
  };

  // Initialize Media Access
  const requestMediaAccess = async () => {
    setIsRequestingPermissions(true);
    setPermissionError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 1280, height: 720 }, 
        audio: { 
          echoCancellation: true, 
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      localStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setHasPermissions(true);

      // Photo capture after 3 seconds
      // setTimeout(() => {
      //   captureCandidatePhoto();
      // }, 3000);

    } catch (err: any) {
      console.error("Media access error:", err);
      setPermissionError("Could not access camera or microphone. Please check permissions.");
    } finally {
      setIsRequestingPermissions(false);
    }
  };

  const addTranscriptMessage = (speaker: string, text: string) => {
    if (!text || text.trim() === "") return;
    
    console.log(`Adding transcript message: [${speaker}] ${text.substring(0, 30)}...`);
    
    const last = transcriptRef.current[transcriptRef.current.length - 1];
    if (last && last.speaker === speaker) {
      // Merge with last message if same speaker
      last.text += (speaker === 'assistant' ? "" : " ") + text;
    } else {
      transcriptRef.current.push({ speaker, text, timestamp: new Date().toISOString() });
    }
    // Update UI state from the ref to ensure consistency
    setTranscript([...transcriptRef.current]);
  };

  // Start Interview logic
  const startLiveInterview = async () => {
    if (!hasPermissions || !localStreamRef.current || isConnecting || isConnected) {
      console.warn("Cannot start interview: ", { hasPermissions, hasStream: !!localStreamRef.current, isConnecting, isConnected });
      return;
    }

    setIsConnecting(true);
    setConnectionError(null);

    // ✅ ADD THIS HERE: Capture exactly when they click to start
    // They are looking at the screen, and the camera exposure is perfect.

      setTimeout(() => {
        captureCandidatePhoto();
      }, 3000);

    try {
      // Pre-flight check for API key
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey || apiKey.trim() === "" || apiKey === "undefined") {
        const errorMsg = "Configuration Error: Gemini API Key is missing from environment variables. Please add it to your project secrets.";
        console.error(errorMsg);
        setConnectionError(errorMsg);
        setIsConnecting(false);
        return;
      }

      console.log("Attempting to connect to Gemini Live API with key length:", apiKey.length);
      const ai = new GoogleGenAI({ apiKey });
      
   const systemInstruction = `CRITICAL LANGUAGE RULE: You are permitted to speak and transcribe ONLY in English or Bengali (Bangla). If the candidate speaks Bengali, you MUST transcribe and respond using the native Bengali alphabet (e.g., 'ধন্যবাদ').

You are InterviewGenie, a professional real-time AI voice interviewer.
Your job is to conduct a complete spoken interview using the recruiter-approved question list.

Candidate Name: ${candidateData.candidate_name}
Applied Role: ${candidateData.applied_role}
Job Description: ${candidateData.job_description || "N/A"}
Candidate Email: ${candidateData.candidate_email || "N/A"}

Approved Question List:
${(candidateData.approved_questions || []).map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}

Opening behavior:
- ALWAYS begin with a short, polite greeting and introduce yourself as the AI interviewer.
- Ask the candidate how they are doing or if they are ready to begin.
- CRITICAL: STOP AND WAIT after your greeting. Do NOT ask the first interview question yet.
- Wait for the candidate to reply to your greeting.
- Once the candidate replies and confirms they are ready, briefly acknowledge it, and THEN ask the first approved question.

Core interview rules & Question Boundaries:
- You are provided exactly ${candidateData.approved_questions ? candidateData.approved_questions.length : 0} approved questions.
- You MUST ask them in exact sequential order.
- Ask exactly one main question at a time.
- PATIENCE DIRECTIVE: After asking ANY question, STOP AND WAIT for the candidate's answer. 
- CRITICAL SILENCE RULE: Human speech naturally includes pauses for thought, breathing, or hesitation. If the candidate pauses briefly, DO NOT interrupt. Only respond when it is absolutely clear they have finished their thought and concluded their answer.
- IF the candidate answers (whether strong or weak): briefly and politely acknowledge it, then IMMEDIATELY move to the next approved question. 
- CRITICAL: You are STRICTLY FORBIDDEN from asking any follow-up questions, probing for more details, or asking for examples. Accept whatever answer they give and move on.
- IF the candidate says "I don't know" or asks to skip: politely acknowledge it and IMMEDIATELY move to the next approved question. Do not force them to guess.
- CRITICAL BOUNDARY: You are STRICTLY FORBIDDEN from generating or asking any new main questions outside of the Approved Question List. 
- TERMINAL STATE: Once the candidate has answered (or skipped) the final approved question, you MUST thank them for their time, state that the interview is complete, and clearly say goodbye. Do NOT ask another question.

Language rules:
- Support pure English, pure Bengali, and mixed Bengali-English speech naturally.
- CRITICAL SCRIPT RULE: You MUST transcribe and respond using the correct native script for each language.
  - If the candidate speaks English, transcribe it in the Latin alphabet (e.g., "Yes, I know Laravel.").
  - If the candidate speaks Bengali, transcribe it in the native Bengali alphabet (e.g., "হ্যাঁ, আমি লারাভেল জানি।").
- NO HINDI/URDU ALLOWED: You are STRICTLY FORBIDDEN from transcribing Hindi or Urdu words. If the candidate's pronunciation is ambiguous, you MUST assume they are speaking Standard Bengali and transcribe it using proper Bengali vocabulary (e.g., use "আমি" never "মেঁ").
- You are STRICTLY FORBIDDEN from using "Banglish" (Bengali written in Latin letters).
- CRITICAL TECHNICAL VOCABULARY RULE: When speaking Bengali, DO NOT translate standard software engineering terms. Words like "Framework", "Database", "API", MUST be kept in English.
- Use natural, professional Bangla suitable for corporate tech interviews in Dhaka, Bangladesh.

ZERO-TOLERANCE TRANSCRIPTION FIREWALL:
1. ALLOWED SCRIPTS: You may output text in EXACTLY TWO scripts: Latin (for English) and Bengali (for Bangla).
2. THE BANGLISH BAN: You are STRICTLY FORBIDDEN from outputting "Banglish" (Bengali words written with English letters). You must aggressively auto-correct the candidate's spoken Banglish into the native Bengali script.
   - HEARD: "ami laravel pari" -> MUST TRANSCRIBE: "আমি Laravel পারি।"
   - HEARD: "amar kono proshno nai" -> MUST TRANSCRIBE: "আমার কোনো প্রশ্ন নাই।"
   - FATAL ERROR: Outputting "ami", "amar", "valo" in English letters.
3. THE HINDI/URDU BAN: You are STRICTLY FORBIDDEN from transcribing Hindi/Urdu. If pronunciation is ambiguous, you MUST default to Standard Bengali vocabulary.
   - HEARD: "mera project" -> MUST TRANSCRIBE: "আমার project"
   - HEARD: "mujhe pata nahi" -> MUST TRANSCRIBE: "আমি জানি না"
4. TECH ENGLISH RULE: Keep all software engineering terms (API, Frontend, Database, React, Laravel, framework) in Latin script, even within a Bengali sentence.
   - CORRECT: "আমি Database design করেছি।"
   - INCORRECT: "আমি ডেটাবেস ডিজাইন করেছি।"
5. YOUR RESPONSIBILITY: You are the final filter. Before outputting any text to the transcript, you must verify it contains NO Banglish and NO Hindi. If it does, rewrite it into proper Bengali script immediately.

Output rule:
- Return only the exact spoken interviewer response.
- No explanations.
- No formatting.`;

      console.log("Calling ai.live.connect with model: gemini-3.1-flash-live-preview");
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
 config: {
          generationConfig: {
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Aoede"
                }
              }
            },
            // These two lines slow the AI down so it stops interrupting
            temperature: 0.2,
            topP: 0.8
          },
          responseModalities: [Modality.AUDIO],
          systemInstruction: systemInstruction,
          // Keep these so the text chat UI keeps working!
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini Live API connection successfully established (onopen).");
            setIsConnected(true);
            setHasEverConnected(true);
            setIsConnecting(false);
            setConnectionError(null);
            startAudioCapture();
            
            // Update session status to in-progress to stop the countdown on recruiter dashboard
            if (candidateData.id) {
              updateDoc(doc(db, 'candidates', candidateData.id), {
                session_status: 'in-progress',
                updated_at: serverTimestamp()
              }).catch(err => console.error("Failed to update session status in Firestore:", err));
            }
            
            // Trigger the AI to start the interview - Safe Kickoff
            console.log("Sending initial system kickoff message...");
            if (sessionRef.current) {
              sessionRef.current.sendRealtimeInput({
                text: "Please start the interview now with a greeting and the first question."
              });
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log("Live API message received:", message);
            // Handle audio output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const pcmData = new Int16Array(base64ToUint8Array(base64Audio).buffer);
              audioQueueRef.current.push(pcmData);
              if (!isPlayingRef.current) {
                playNextInQueue();
              }
            }

            // Handle native transcription (Robust Capture)
            const serverContent = message.serverContent as any;
            if (serverContent) {
              // 1. Extract User Speech (Candidate)
              let userText = "";
              if (serverContent.userTurn?.parts) {
                userText = serverContent.userTurn.parts.map((p: any) => p.text || "").join("").trim();
              }
              
              // Fallback for input transcription fields
              if (!userText) {
                userText = serverContent.inputAudioTranscription?.text || serverContent.inputTranscription?.text || "";
              }

              if (userText) {
                addTranscriptMessage('Candidate', userText);
              }

              // 2. Extract AI Speech (Assistant)
              let aiText = "";
              if (serverContent.modelTurn?.parts) {
                aiText = serverContent.modelTurn.parts.map((p: any) => p.text || "").join("").trim();
              }

              // Fallback for output transcription fields
              if (!aiText) {
                aiText = serverContent.outputAudioTranscription?.text || serverContent.outputTranscription?.text || "";
              }

              if (aiText) {
                addTranscriptMessage('assistant', aiText);
              }

              if (!userText && !aiText && (serverContent.userTurn || serverContent.modelTurn)) {
                console.log("serverContent received with turns but no text parts found:", serverContent);
              }
            }
          },
          onclose: (event) => {
            console.log("Gemini Live API connection closed:", event);
            if (!hasEverConnected) {
              console.error("Connection closed before it could be established. Code:", event.code, "Reason:", event.reason);
              
              let errorMsg = "Connection closed unexpectedly. Please try again.";
              if (event.code === 1007) {
                errorMsg = "Configuration Error: Invalid Gemini API Key. Please check your project secrets.";
              } else if (event.reason) {
                errorMsg = `Connection failed: ${event.reason}`;
              }

              setConnectionError(errorMsg);
              setIsConnecting(false);
              setIsConnected(false);
              sessionRef.current = null;
            } else {
              stopInterview();
            }
          },
          onerror: (error) => {
            console.error("Gemini Live API Error details:", error);
            if (!hasEverConnected) {
              setConnectionError(`Connection failed: ${error.message || "Unknown error"}. Please check your network and try again.`);
              setIsConnecting(false);
              setIsConnected(false);
              sessionRef.current = null;
            } else {
              stopInterview();
            }
          }
        }
      });

      sessionRef.current = session;
    } catch (err: any) {
      console.error("Critical error during Gemini connection initialization:", err);
      setIsConnecting(false);
      setConnectionError(`Failed to initialize connection: ${err.message || "Unknown error"}`);
    }
  };

  const startAudioCapture = async () => {
    try {
      const stream = localStreamRef.current;
      if (!stream) return;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await audioContext.audioWorklet.addModule(url);
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor', {
        processorOptions: { sampleRate: audioContext.sampleRate }
      });
      processorRef.current = workletNode as any;

      workletNode.port.onmessage = (e) => {
        if (isMuted || !sessionRef.current) return;
        const pcmData = e.data;
        sessionRef.current.sendRealtimeInput({
          audio: {
            mimeType: "audio/pcm;rate=16000",
            data: uint8ArrayToBase64(new Uint8Array(pcmData.buffer))
          }
        });

        // Simple audio level calculation (from PCM data)
        let sum = 0;
        for (let i = 0; i < pcmData.length; i++) {
          sum += (pcmData[i] / 32768) * (pcmData[i] / 32768);
        }
        setAudioLevel(Math.sqrt(sum / pcmData.length));
      };

      source.connect(workletNode);
      workletNode.connect(audioContext.destination);
    } catch (err) {
      console.error("Audio capture error:", err);
    }
  };

  const playNextInQueue = () => {
    if (audioQueueRef.current.length === 0 || !audioContextRef.current) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    const pcmData = audioQueueRef.current.shift()!;
    const float32Data = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      float32Data[i] = pcmData[i] / 32768.0;
    }

    const buffer = audioContextRef.current.createBuffer(1, float32Data.length, 24000);
    buffer.getChannelData(0).set(float32Data);
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.onended = () => playNextInQueue();
    source.start();
  };

const stopInterview = async () => {
    // 1. Verify we have an ID to save to
    if (!candidateData.id) {
      console.error("FATAL: No interview ID found. Cannot save.");
      alert("Error: Missing session ID. Please contact the recruiter.");
      return; 
    }

    try {
      console.log("1. Starting safe shutdown. Locking UI...");
      setIsSaving(true);

      const finalTranscript = transcriptRef.current;
      const transcriptText = finalTranscript.map(e => `${e.speaker === 'assistant' ? 'AI' : 'Candidate'}: ${e.text}`).join('\n\n');
      
      if (finalTranscript.length === 0) {
        console.warn("Saving session with EMPTY transcript. Candidate ID:", candidateData.id);
      }
      
      console.log("2. Awaiting Firebase save BEFORE modifying any UI or WebSocket state...");
      await setDoc(doc(db, 'candidates', candidateData.id), { 
        status: 'completed',
        session_status: 'completed', //  ADD THIS CRITICAL LINE
        transcript: finalTranscript,
        transcript_text: transcriptText,
        ended_at: serverTimestamp(),
        updated_at: serverTimestamp()
      }, { merge: true });

      // Auto-generate evaluation
      if (transcriptText.trim() === "") {
        await setDoc(doc(db, 'candidates', candidateData.id), { 
          evaluation: { error: "Transcription not found. Unable to generate evaluation." },
          score: null,
          status: 'completed',
          session_status: 'completed',
          updated_at: serverTimestamp() 
        }, { merge: true });
      } else {
        try {
          const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
          
          // --- UPDATED PROMPT: Injecting the approved questions for strict grading ---
          const prompt = `You are an expert technical recruiter and AI evaluator. Analyze the following interview transcript for a preliminary screening for the role of ${candidateData.applied_role || 'the position'}.

The candidate was asked the following approved questions:
${(candidateData.approved_questions || []).map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}

CRITICAL GRADING RULE: Evaluate the candidate STRICTLY on how well they answered these specific approved questions. Do not penalize them for not discussing topics outside of these questions, and do not penalize them for lacking advanced or senior-level nuance.

Return a strict JSON object. "score": (number 1-10). Grade them based on a preliminary screening standard. If they answer the basic concepts of the approved questions correctly, they should score highly (8-10).

Include these keys: 'score', 'summary' (string, 2 sentences max), 'strengths' (array of 3 strings), 'weaknesses' (array of 3 strings). Do not return markdown, only raw JSON. 

Transcript: 
${transcriptText}`;

          const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
              responseMimeType: "application/json",
            }
          });
          
          const parsedData = JSON.parse(response.text || "{}");
          await setDoc(doc(db, 'candidates', candidateData.id), { 
            evaluation: parsedData,
            score: parsedData.score,
            status: 'completed',
            session_status: 'completed',
            updated_at: serverTimestamp() 
          }, { merge: true });
        } catch (evalError) {
          console.error("Auto-evaluation failed:", evalError);
          await setDoc(doc(db, 'candidates', candidateData.id), { 
            evaluation: { error: "Failed to generate evaluation. Please try again later." },
            score: null,
            status: 'completed',
            session_status: 'completed',
            updated_at: serverTimestamp() 
          }, { merge: true });
        }
      }

      console.log("3. Firebase save confirmed! Safe to close hardware/sockets.");
      
      // 4. NOW it is safe to close WebSockets, stop media tracks, and change React state
      if (sessionRef.current) {
        try { sessionRef.current.close(); } catch(e) { /* ignore safe close errors */ }
        sessionRef.current = null;
      }

      // Cleanup media tracks explicitly to turn off webcam light
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => {
          track.stop();
          console.log(`Stopped track: ${track.kind}`);
        });
        localStreamRef.current = null;
      }
      
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(console.error);
        audioContextRef.current = null;
      }

      setIsConnected(false);
      setIsConnecting(false);
      audioQueueRef.current = [];
      isPlayingRef.current = false;
      
      setIsCompleted(true); // Show the Thank You screen
      
      if (onComplete) onComplete();
    } catch (error) {
      console.error("CRITICAL FIREBASE ERROR:", error);
      alert("Failed to save session to the database. Please check your internet connection and try again.");
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript.length]);

  if (isCompleted || candidateData.status === 'completed') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-white p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-[32px] p-10 text-center space-y-8 shadow-2xl"
        >
          <div className="w-24 h-24 bg-emerald-500/10 rounded-3xl flex items-center justify-center mx-auto text-emerald-500 shadow-inner">
            <CheckCircle2 className="w-12 h-12" />
          </div>
          <div className="space-y-4">
            <h2 className="text-3xl font-black tracking-tight text-white">Interview Completed Successfully</h2>
            <p className="text-slate-400 leading-relaxed">
              Your responses have been securely saved. The recruiting team will review your session and contact you shortly. You may now close this window.
            </p>
          </div>
          <div className="pt-6 border-t border-slate-800">
            <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em] font-bold">
              Session Secured & Finalized
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-white p-6 font-sans">
      <div className="w-full max-w-5xl bg-slate-900/50 backdrop-blur-xl border border-slate-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col h-[800px]">
        
        {/* Header */}
        <div className="p-8 border-b border-slate-800 flex items-center justify-between bg-slate-900/30 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold truncate">{candidateData.applied_role}</h2>
            <div className="flex items-center gap-4 mt-1">
              <p className="text-slate-400 text-xs">Candidate: {candidateData.candidate_name}</p>
              {isConnected && (
                <>
                  <div className="h-4 w-px bg-slate-800" />
                  <p className="text-blue-400 text-xs font-bold uppercase tracking-wider">Live Session</p>
                </>
              )}
            </div>
          </div>
          {isConnected && (
            <div className="flex items-center gap-2 px-3 py-1 bg-green-500/10 border border-green-500/20 rounded-full">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-xs font-medium text-green-500">Live</span>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 p-8 flex flex-col items-center justify-center gap-8 overflow-y-auto">
          {!hasPermissions ? (
            <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 text-center space-y-6">
              <div className="w-20 h-20 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto text-blue-500">
                <Mic className="w-10 h-10" />
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-bold">Ready to start?</h3>
                <p className="text-sm text-slate-400">We need access to your camera and microphone to conduct the interview.</p>
              </div>
              {permissionError && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400">
                  {permissionError}
                </div>
              )}
              <button
                onClick={requestMediaAccess}
                disabled={isRequestingPermissions}
                className="w-full py-4 bg-blue-600 hover:bg-blue-500 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all"
              >
                {isRequestingPermissions ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                Grant Permissions
              </button>
            </div>
          ) : !isConnected ? (
            <div className="relative w-full max-w-2xl aspect-video bg-slate-900 rounded-3xl overflow-hidden border border-slate-800 shadow-2xl">
              <video 
                ref={videoRef} 
                autoPlay 
                muted 
                playsInline 
                className="w-full h-full object-cover rounded-lg"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 to-transparent flex flex-col items-center justify-end p-8">
                {connectionError && (
                  <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 text-center max-w-md animate-in fade-in slide-in-from-bottom-2">
                    {connectionError}
                  </div>
                )}
                
                {/* Hide button if it's a critical configuration error */}
                {(!connectionError || !connectionError.includes("Configuration Error")) && (
                  <button
                    onClick={startLiveInterview}
                    disabled={isConnecting}
                    className="px-12 py-4 bg-blue-600 hover:bg-blue-500 rounded-2xl font-bold flex items-center justify-center gap-3 transition-all shadow-xl shadow-blue-600/40 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isConnecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
                    {connectionError ? 'Retry Connection' : 'Start Interview'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Side-by-Side Layout */}
              <div className="flex flex-col lg:flex-row gap-8 w-full max-w-7xl flex-1 min-h-0">
                {/* Left Side: Video & Visualizer (60%) */}
                <div className="lg:w-[60%] flex flex-col gap-6">
                  <div className="relative aspect-video bg-slate-900 rounded-[32px] overflow-hidden border border-slate-800 shadow-2xl group">
                    <video 
                      ref={videoRef} 
                      autoPlay 
                      muted 
                      playsInline 
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent opacity-60" />
                    <div className="absolute bottom-6 left-6 flex items-center gap-3 px-4 py-2 bg-slate-950/40 backdrop-blur-xl rounded-2xl border border-white/5">
                      <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                      <span className="text-xs font-bold text-white uppercase tracking-widest">
                        Live Feed
                      </span>
                    </div>
                  </div>

                  {/* AI Visualizer & Controls */}
                  <div className="flex items-center justify-between p-6 bg-slate-900/50 rounded-[32px] border border-slate-800/50 backdrop-blur-sm">
                    <div className="flex items-center gap-6">
                      <div className="relative flex items-center justify-center w-16 h-16">
                        <AnimatePresence>
                          <motion.div
                            animate={{ scale: 1 + audioLevel * 0.5, opacity: 0.2 + audioLevel * 0.3 }}
                            className="absolute inset-0 bg-blue-500 rounded-full blur-2xl"
                          />
                        </AnimatePresence>
                        <div className="relative z-10 w-12 h-12 rounded-full flex items-center justify-center bg-blue-600 shadow-lg">
                          <Bot className="w-6 h-6 text-white" />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <h4 className="text-sm font-bold text-white">InterviewGenie</h4>
                        <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">AI Interviewer Active</p>
                      </div>
                    </div>

                        <div className="flex items-center gap-4">
                          <button
                            onClick={() => setIsMuted(!isMuted)}
                            className={`p-4 rounded-2xl transition-all ${isMuted ? 'bg-red-500/10 text-red-500 border border-red-500/20' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                          >
                            {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                          </button>
                          <button
                            onClick={stopInterview}
                            disabled={isSaving}
                            className="flex items-center gap-2 px-8 py-4 bg-red-600 hover:bg-red-700 text-white rounded-2xl font-bold transition-all shadow-lg shadow-red-600/20 disabled:opacity-50"
                          >
                            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4 fill-current" />}
                            {isSaving ? 'Saving...' : 'End Session'}
                          </button>
                        </div>
                  </div>
                </div>

                {/* Right Side: Live Transcription (40%) */}
                <div className="lg:w-[40%] flex flex-col min-h-0">
                  <div className="flex-1 flex flex-col bg-slate-900/40 backdrop-blur-xl rounded-[32px] border border-slate-800/50 overflow-hidden shadow-2xl">
                    <div className="p-6 border-b border-slate-800/50 flex items-center justify-between bg-slate-900/20">
                      <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                        <MessageSquare className="w-3 h-3 text-blue-400" />
                        Live Transcription
                      </h3>
                      <div className="flex items-center gap-1.5 px-2 py-0.5 bg-blue-500/10 rounded-full">
                        <div className="w-1 h-1 bg-blue-500 rounded-full animate-pulse" />
                        <span className="text-[9px] font-bold text-blue-500 uppercase tracking-wider">Syncing</span>
                      </div>
                    </div>

                        <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-hide">
                      {transcript.length === 0 && (
                        <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-40">
                          <div className="w-12 h-12 rounded-2xl bg-slate-800 flex items-center justify-center">
                            <Bot className="w-6 h-6" />
                          </div>
                          <p className="text-xs font-medium text-slate-400">Waiting for conversation to start...</p>
                        </div>
                      )}
                      {transcript.map((entry, i) => (
                        <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          key={i} 
                          className={`flex gap-4 ${entry.speaker === 'assistant' ? 'flex-row' : 'flex-row-reverse'}`}
                        >
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm ${entry.speaker === 'assistant' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
                            {entry.speaker === 'assistant' ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
                          </div>
                          <div className={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed shadow-sm ${entry.speaker === 'assistant' ? 'bg-slate-800/80 text-blue-50 border border-slate-700/50' : 'bg-blue-600 text-white'}`}>
                            {i === transcript.length - 1 && entry.speaker === 'assistant' ? (
                              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
                                {entry.text}
                              </motion.div>
                            ) : (
                              entry.text
                            )}
                          </div>
                        </motion.div>
                      ))}
                      <div ref={transcriptEndRef} />
                    </div>
                  </div>
                </div>
              </div>
              <canvas ref={canvasRef} className="hidden" />
            </>
          )}
        </div>
      </div>
    </div>
  );
};
