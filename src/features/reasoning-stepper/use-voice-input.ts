'use client';

import { useCallback, useRef, useState, useSyncExternalStore } from 'react';

/**
 * Optional voice-to-text, via the browser's own speech recognition.
 *
 * A seam, deliberately: it is feature-detected, adds no dependency, and the
 * control is simply absent where the API is not available. Nothing in the
 * reasoning flow depends on it — text is always the primary path.
 */

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean }
  >;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

// Support is a fixed property of the environment, read through
// useSyncExternalStore so server and client agree during hydration.
const noopSubscribe = () => () => {};

export type VoiceInput = {
  supported: boolean;
  listening: boolean;
  start: () => void;
  stop: () => void;
};

export function useVoiceInput(onTranscript: (text: string) => void): VoiceInput {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const supported = useSyncExternalStore(
    noopSubscribe,
    () => getRecognitionConstructor() !== null,
    () => false,
  );

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Recognition = getRecognitionConstructor();
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = document.documentElement.lang || 'en';

    recognition.onresult = (event) => {
      let transcript = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) {
          transcript += result[0]?.transcript ?? '';
        }
      }
      if (transcript.trim().length > 0) {
        onTranscript(transcript.trim());
      }
    };

    recognition.onerror = () => {
      recognitionRef.current = null;
      setListening(false);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [onTranscript]);

  return { supported, listening, start, stop };
}
