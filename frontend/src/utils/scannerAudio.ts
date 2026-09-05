type ScannerTone = "success" | "duplicate" | "error" | "offline";

let audioContext: AudioContext | null = null;

function getAudioContext() {
  if (typeof window === "undefined") return null;
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  audioContext ||= new AudioContextClass();
  return audioContext;
}

function tone(context: AudioContext, frequency: number, start: number, duration: number, gainValue: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.012);
}

export function playScannerTone(kind: ScannerTone) {
  try {
    const context = getAudioContext();
    if (!context) return;
    const start = context.currentTime;
    if (context.state === "suspended") void context.resume();
    if (kind === "success") tone(context, 880, start, 0.075, 0.055);
    else if (kind === "offline") tone(context, 520, start, 0.09, 0.045);
    else if (kind === "duplicate") {
      tone(context, 260, start, 0.085, 0.05);
      tone(context, 190, start + 0.11, 0.085, 0.05);
    } else {
      tone(context, 180, start, 0.09, 0.05);
      tone(context, 140, start + 0.12, 0.1, 0.05);
    }
  } catch (_error) {
    // Audio is optional and must never interrupt attendance processing.
  }
}

export function flashScannerEdge(kind: "success" | "duplicate" | "error" | "offline") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.scannerFeedback = kind;
  window.setTimeout(() => {
    if (root.dataset.scannerFeedback === kind) delete root.dataset.scannerFeedback;
  }, 180);
}
