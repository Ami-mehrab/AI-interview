/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import InterviewInterface from './components/InterviewInterface';
import { CandidateGate } from './components/CandidateGate';
import { InterviewSession } from './components/InterviewSession';

const MainApp = () => {
  // 1. Use React Router's hook to safely track the URL parameters
  const [searchParams] = useSearchParams();
  const interviewId = searchParams.get('id');
  
  const [verifiedData, setVerifiedData] = useState<any>(null);

  // 2. THE TRAFFIC COP: If an ID exists, lock them into the Candidate Flow
  if (interviewId) {
    // Step B: Candidate is verified, let them into the interview room
    if (verifiedData) {
      return (
        <InterviewSession 
          candidateData={verifiedData} 
          onComplete={() => {
            // Optional: You can reset state here or show a custom ending UI
            console.log("Session marked as complete.");
          }}
        />
      );
    }
    
    // Step A: Candidate just arrived, make them pass the gate first
    return (
      <CandidateGate 
        id={interviewId} 
        onSuccess={(data) => setVerifiedData(data)} 
      />
    );
  }

  // 3. No ID in the URL? Welcome to the Recruiter Dashboard.
  return <InterviewInterface />;
};

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-slate-950">
        <Routes>
          <Route path="/" element={<MainApp />} />
          {/* Catch-all: If someone types a weird URL, redirect them home but keep their ID string intact */}
          <Route path="*" element={<Navigate to={`/?${window.location.search}`} replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}