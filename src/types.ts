export interface AsrChunk {
  text: string;
  timestamp: [number, number | null]; // الكلمة الأخيرة قد يأتي وقت نهايتها null
}

export interface QuranWord {
  surah: number;
  ayah: number;
  word: number;
  uthmani: string; // النص الذي يُعرض في الفيديو
  norm: string;    // النص بعد normalize، ويُستخدم للمقارنة
}

export interface TimedWord extends QuranWord {
  start: number;
  end: number;
}

export interface ProgressItem {
  file: string;
  progress?: number;
}

// الرسائل المرسلة من الواجهة إلى الـ Worker
export interface WorkerRequest {
  audio: Float32Array;
}

// الرسائل الراجعة من الـ Worker
export type WorkerResponse =
  | { status: "initiate"; file: string; name: string }
  | { status: "progress"; file: string; progress: number; loaded: number; total: number }
  | { status: "done"; file: string }
  | { status: "ready" }
  | { status: "complete"; chunks: AsrChunk[] }
  | { status: "error"; message: string };