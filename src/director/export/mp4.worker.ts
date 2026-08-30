// src/director/export/mp4.worker.ts
// 导演台 MP4/WebM 编码 Worker（独立编码路径）：接收主线程逐帧 ImageBitmap，
// 用 OffscreenCanvas + captureStream + MediaRecorder 编码为视频 Blob。
// 无第三方依赖；容器优先 MP4，环境不支持时回退 WebM（VP9）。

/// <reference lib="webworker" />

interface WorkerInitMessage {
  type: 'init';
  width: number;
  height: number;
  fps: number;
  videoBitsPerSecond: number;
}

interface WorkerFrameMessage {
  type: 'frame';
  bitmap: ImageBitmap;
}

interface WorkerFinishMessage {
  type: 'finish';
}

interface WorkerCancelMessage {
  type: 'cancel';
}

type WorkerMessage = WorkerInitMessage | WorkerFrameMessage | WorkerFinishMessage | WorkerCancelMessage;

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let cancelled = false;
let finished = false;

function pickMimeType(): string {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const m of candidates) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // 继续尝试下一个
    }
  }
  return 'video/webm';
}

function handleInit(msg: WorkerInitMessage): void {
  try {
    if (typeof OffscreenCanvas === 'undefined') {
      postMessage({ type: 'error', message: '当前环境不支持 OffscreenCanvas，无法在独立 Worker 中编码' });
      return;
    }
    cancelled = false;
    finished = false;
    chunks = [];
    canvas = new OffscreenCanvas(msg.width, msg.height);
    ctx = canvas.getContext('2d');
    if (!ctx) {
      postMessage({ type: 'error', message: '无法创建离屏 2D 上下文' });
      return;
    }
    // TS DOM 类型未覆盖 OffscreenCanvas.captureStream（Chromium 实际支持），此处安全断言
    const captureFn = (canvas as unknown as { captureStream?: (fps: number) => MediaStream }).captureStream;
    if (typeof captureFn !== 'function') {
      postMessage({ type: 'error', message: '当前环境不支持离屏捕获（captureStream）' });
      return;
    }
    stream = captureFn.call(canvas, msg.fps);
    const mimeType = pickMimeType();
    const isMp4 = mimeType.startsWith('video/mp4');
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: msg.videoBitsPerSecond,
    });
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      if (cancelled) {
        postMessage({ type: 'cancelled' });
        return;
      }
      const blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
      postMessage({ type: 'result', blob, container: isMp4 ? 'mp4' : 'webm', mimeType }, [blob] as unknown as Transferable[]);
    };
    recorder.start(200); // 每 200ms 收集一次数据块
    postMessage({ type: 'ready', mimeType, container: isMp4 ? 'mp4' : 'webm' });
  } catch (e) {
    postMessage({ type: 'error', message: `初始化编码器失败：${(e as Error).message}` });
  }
}

function handleFrame(bitmap: ImageBitmap): void {
  if (!ctx || !recorder || recorder.state === 'inactive') {
    bitmap.close();
    return;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
}

function handleFinish(): void {
  finished = true;
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
}

function handleCancel(): void {
  cancelled = true;
  finished = true;
  if (recorder && recorder.state !== 'inactive') {
    try {
      recorder.stop();
    } catch {
      // 忽略停止异常
    }
  }
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      handleInit(msg);
      break;
    case 'frame':
      handleFrame(msg.bitmap);
      break;
    case 'finish':
      handleFinish();
      break;
    case 'cancel':
      handleCancel();
      break;
    default:
      break;
  }
};

export {};
