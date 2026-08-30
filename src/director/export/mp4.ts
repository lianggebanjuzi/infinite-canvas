// src/director/export/mp4.ts
// 导演台时间轴视频导出：独立 Worker 编码路径（mp4.worker.ts）。
// 主线程按 FPS 渲染帧 → ImageBitmap 转移给 Worker → OffscreenCanvas + MediaRecorder 编码。
// 支持进度回调、取消（长导出取消后应用可继续使用）、磁盘空间错误提示。

import * as THREE from 'three';
import { cameraManager } from '../engine/camera';
import { sceneManager } from '../engine/scene';
import { referenceManager } from '../engine/reference';
import { lightingManager } from '../engine/lighting';
import { timeline } from '../engine/timeline';

export interface ExportMp4Options {
  /** 输出宽度（默认 640；高度按 active camera 画幅推导） */
  width?: number;
  height?: number;
  /** 导出帧率（默认取时间轴 FPS，上限 30） */
  fps?: number;
  /** 导出区间（默认 0..时间轴时长） */
  from?: number;
  to?: number;
  onProgress?: (done: number, total: number) => void;
  /** 取消回调：返回 true 时中止导出 */
  shouldCancel?: () => boolean;
}

export interface Mp4ExportResult {
  status: 'success' | 'cancelled' | 'error';
  path?: string;
  container?: string;
  width?: number;
  height?: number;
  duration?: number;
  message?: string;
}

interface VideoSaveBackend {
  director_save_video_blob(base64: string, filename?: string): Promise<{ status: string; path?: string; sizeBytes?: number; message?: string }>;
}

interface WorkerResponse {
  type: 'ready' | 'frame' | 'result' | 'cancelled' | 'error';
  mimeType?: string;
  container?: string;
  blob?: Blob;
  message?: string;
}

function getBackend(): VideoSaveBackend | null {
  const w = window as unknown as { pywebview?: { api?: VideoSaveBackend } };
  return w.pywebview?.api ?? null;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('读取视频数据失败'));
    reader.readAsDataURL(blob);
  });
}

export async function exportMp4(opts: ExportMp4Options = {}): Promise<Mp4ExportResult> {
  const cam = cameraManager.getActive();
  const threeCam = cameraManager.getActiveThreeCamera();
  if (!cam || !threeCam) {
    return { status: 'error', message: '没有可用的活动摄像机' };
  }

  const aspect = cam.aspect > 0 ? cam.aspect : 16 / 9;
  const height = Math.max(64, Math.min(1080, opts.height ?? 360));
  const width = opts.width && opts.width > 0 ? opts.width : Math.round(height * aspect);
  const fps = Math.min(30, Math.max(4, opts.fps ?? timeline.data.fps));
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(timeline.data.duration, opts.to && opts.to > from ? opts.to : timeline.data.duration);
  const totalFrames = Math.max(1, Math.round((to - from) * fps));
  const span = to - from;

  const backend = getBackend();
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./mp4.worker.ts', import.meta.url));
  } catch (e) {
    return { status: 'error', message: `创建编码 Worker 失败：${(e as Error).message}` };
  }

  return new Promise<Mp4ExportResult>((resolve) => {
    let settled = false;
    let recorderReady = false;

    const restoreAfterExport = (): void => {
      referenceManager.applyEditVisibility();
      timeline.applyFrame(timeline.playhead);
    };

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      try { worker?.terminate(); } catch { /* 忽略 */ }
      restoreAfterExport();
      resolve({ status: 'error', message });
    };

    const timer = setTimeout(() => {
      if (!recorderReady) fail('编码器初始化超时');
    }, 8000);

    worker.onmessage = async (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          recorderReady = true;
          clearTimeout(timer);
          break;
        case 'error':
          clearTimeout(timer);
          fail(msg.message || '编码器错误');
          break;
        case 'cancelled':
          if (settled) return;
          settled = true;
          try { worker?.terminate(); } catch { /* 忽略 */ }
          restoreAfterExport();
          resolve({ status: 'cancelled', message: '导出已取消' });
          break;
        case 'result': {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          try {
            const blob = msg.blob;
            if (!blob) {
              fail('编码结果为空');
              return;
            }
            restoreAfterExport();
            const base64 = await blobToBase64(blob);
            if (!backend) {
              resolve({
                status: 'success',
                container: msg.container,
                width, height, duration: span,
                message: '无后端，仅完成编码（未写盘）',
              });
              return;
            }
            const filename = `director-shot-${Date.now()}.${msg.container === 'mp4' ? 'mp4' : 'webm'}`;
            const res = await backend.director_save_video_blob(base64, filename);
            if (res.status !== 'success') {
              resolve({ status: 'error', message: res.message || '保存视频失败' });
              return;
            }
            resolve({
              status: 'success',
              path: res.path,
              container: msg.container,
              width, height, duration: span,
            });
          } catch (e) {
            fail(`处理编码结果失败：${(e as Error).message}`);
          } finally {
            try { worker?.terminate(); } catch { /* 忽略 */ }
          }
          break;
        }
        default:
          break;
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      clearTimeout(timer);
      fail(`编码 Worker 异常：${e.message || '未知错误'}`);
    };

    // 初始化 worker
    worker.postMessage({
      type: 'init',
      width,
      height,
      fps,
      videoBitsPerSecond: 3_000_000, // 低分辨率默认 3Mbps
    });

    void (async () => {
      // 等待 worker 就绪
      while (!recorderReady && !settled) {
        await sleep(30);
      }
      if (settled) return;

      // 创建导出专用渲染器（离屏，不影响视口）
      let offscreen: OffscreenCanvas;
      try {
        offscreen = new OffscreenCanvas(width, height);
      } catch {
        fail('当前环境不支持 OffscreenCanvas');
        return;
      }
      const renderer = new THREE.WebGLRenderer({ canvas: offscreen, antialias: false });
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = lightingManager.lighting.exposure;
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      referenceManager.applyExportVisibility();

      try {
        for (let i = 0; i < totalFrames; i++) {
          if (opts.shouldCancel && opts.shouldCancel()) {
            worker?.postMessage({ type: 'cancel' });
            // 等待 worker 回 cancelled（不在这里 settle，避免竞态）
            const waitCancel = setTimeout(() => {
              if (!settled) {
                settled = true;
                try { worker?.terminate(); } catch { /* 忽略 */ }
                restoreAfterExport();
                renderer.dispose();
                resolve({ status: 'cancelled', message: '导出已取消' });
              }
            }, 3000);
            void waitCancel;
            return;
          }
          // 隐藏窗口时暂停编码（不持续编码）
          while (document.hidden && !(opts.shouldCancel && opts.shouldCancel())) {
            await sleep(120);
          }
          const t = from + (i / totalFrames) * span;
          timeline.applyFrame(t);
          renderer.render(sceneManager.scene, threeCam);
          const bitmap = await createImageBitmap(offscreen);
          worker?.postMessage({ type: 'frame', bitmap }, [bitmap]);
          if (opts.onProgress) opts.onProgress(i + 1, totalFrames);
          await sleep(1000 / fps);
        }
        worker?.postMessage({ type: 'finish' });
      } catch (e) {
        try { worker?.postMessage({ type: 'cancel' }); } catch { /* 忽略 */ }
        fail(`渲染帧失败：${(e as Error).message}`);
      } finally {
        renderer.dispose();
      }
    })();
  });
}
