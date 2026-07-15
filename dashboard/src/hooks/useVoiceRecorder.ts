import { useState, useRef, useCallback, useEffect } from 'react';

export type RecorderState = 'idle' | 'recording' | 'sending';

interface UseVoiceRecorderReturn {
  /** Current state of the recorder */
  state: RecorderState;
  /** Elapsed recording time in seconds */
  elapsed: number;
  /** Start recording from the microphone */
  startRecording: () => Promise<void>;
  /** Stop recording and return the audio Blob (ogg/opus for WhatsApp PTT compatibility) */
  stopRecording: () => Promise<Blob | null>;
  /** Cancel the current recording without producing a blob */
  cancelRecording: () => void;
}

/**
 * Hook that wraps the MediaRecorder API to capture voice notes from the user's
 * microphone.  Records as `audio/ogg; codecs=opus` when supported (native PTT
 * format for WhatsApp), falling back to `audio/webm; codecs=opus`.
 */
export function useVoiceRecorder(): UseVoiceRecorderReturn {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsed, setElapsed] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolveRef = useRef<((blob: Blob | null) => void) | null>(null);

  // Determine the best supported mime type for WhatsApp voice notes.
  const getMimeType = useCallback((): string => {
    // Preferred: ogg/opus — the native WhatsApp PTT format.
    if (MediaRecorder.isTypeSupported('audio/ogg; codecs=opus')) {
      return 'audio/ogg; codecs=opus';
    }
    // Fallback: webm/opus — Chrome default, the backend can still handle it.
    if (MediaRecorder.isTypeSupported('audio/webm; codecs=opus')) {
      return 'audio/webm; codecs=opus';
    }
    // Last resort: let the browser pick.
    return '';
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (state !== 'idle') return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = getMimeType();
      const options: MediaRecorderOptions = mimeType ? { mimeType } : {};
      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/ogg; codecs=opus',
        });
        chunksRef.current = [];
        releaseStream();
        clearTimer();

        if (resolveRef.current) {
          resolveRef.current(blob);
          resolveRef.current = null;
        }
        setState('idle');
      };

      recorder.onerror = () => {
        chunksRef.current = [];
        releaseStream();
        clearTimer();
        setState('idle');
        setElapsed(0);
        if (resolveRef.current) {
          resolveRef.current(null);
          resolveRef.current = null;
        }
      };

      recorder.start();
      setState('recording');
      setElapsed(0);

      // Elapsed timer — tick every second.
      timerRef.current = setInterval(() => {
        setElapsed(prev => prev + 1);
      }, 1000);
    } catch {
      // Permission denied or no mic available — stay idle.
      releaseStream();
      setState('idle');
    }
  }, [state, getMimeType, releaseStream, clearTimer]);

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== 'recording') {
        resolve(null);
        return;
      }

      resolveRef.current = resolve;
      setState('sending');
      recorder.stop();
    });
  }, []);

  const cancelRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      // Detach the onstop handler so it doesn't fire the resolve with a blob.
      recorder.onstop = null;
      recorder.stop();
    }
    chunksRef.current = [];
    releaseStream();
    clearTimer();
    setState('idle');
    setElapsed(0);
    if (resolveRef.current) {
      resolveRef.current(null);
      resolveRef.current = null;
    }
  }, [releaseStream, clearTimer]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === 'recording') {
        recorder.onstop = null;
        recorder.stop();
      }
      releaseStream();
      clearTimer();
    };
  }, [releaseStream, clearTimer]);

  return { state, elapsed, startRecording, stopRecording, cancelRecording };
}
