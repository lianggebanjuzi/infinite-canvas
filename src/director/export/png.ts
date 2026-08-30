// src/director/export/png.ts
// 导演台单帧 PNG 导出：使用与监看器/摄像机视角完全相同的 scene + active camera + lighting，
// 保证「导出 PNG 与监看器一致」。

import * as THREE from 'three';
import { cameraManager } from '../engine/camera';
import { sceneManager } from '../engine/scene';
import { referenceManager } from '../engine/reference';
import { lightingManager } from '../engine/lighting';
import { timeline } from '../engine/timeline';

export interface ExportPngOptions {
  /** 输出高度（默认 720；宽度按 active camera 画幅推导） */
  height?: number;
  width?: number;
  /** 时间点（秒；缺省用当前播放头） */
  time?: number;
}

export interface PngExportResult {
  status: 'success' | 'error' | 'cancelled';
  path?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  message?: string;
}

export interface PngSaveBackend {
  director_save_image_from_data_url(dataUrl: string, filename?: string): Promise<{ status: string; path?: string; message?: string }>;
}

function getBackend(): PngSaveBackend | null {
  const w = window as unknown as { pywebview?: { api?: PngSaveBackend } };
  return w.pywebview?.api ?? null;
}

/** 渲染当前场景到离屏 canvas（返回 canvas；不写盘） */
export function renderFrameToCanvas(opts: ExportPngOptions = {}): { canvas: HTMLCanvasElement; width: number; height: number } | null {
  const cam = cameraManager.getActive();
  const threeCam = cameraManager.getActiveThreeCamera();
  if (!cam || !threeCam) return null;

  const aspect = cam.aspect > 0 ? cam.aspect : 16 / 9;
  const height = Math.max(64, Math.min(2160, opts.height ?? 720));
  const width = opts.width && opts.width > 0 ? opts.width : Math.round(height * aspect);

  // 应用时间点（导出帧与监看器同一求值路径）
  const time = opts.time ?? timeline.playhead;
  timeline.applyFrame(time);
  // 导出模式：隐藏不参与导出的参考图
  referenceManager.applyExportVisibility();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = lightingManager.lighting.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.render(sceneManager.scene, threeCam);
  renderer.dispose();

  // 恢复编辑可见性，并回到当前播放头状态
  referenceManager.applyEditVisibility();
  timeline.applyFrame(timeline.playhead);
  return { canvas, width, height };
}

/** 导出 PNG：渲染 → dataURL → 后端保存 → 返回路径 */
export async function exportPng(opts: ExportPngOptions = {}): Promise<PngExportResult> {
  const backend = getBackend();
  const frame = renderFrameToCanvas(opts);
  if (!frame) {
    return { status: 'error', message: '没有可用的活动摄像机' };
  }
  try {
    const dataUrl = frame.canvas.toDataURL('image/png');
    if (!backend) {
      return { status: 'success', dataUrl, width: frame.width, height: frame.height, message: '无后端，仅返回 dataURL' };
    }
    const res = await backend.director_save_image_from_data_url(dataUrl, `director-frame-${Date.now()}.png`);
    if (res.status !== 'success') {
      return { status: 'error', message: res.message || '保存 PNG 失败' };
    }
    return { status: 'success', path: res.path, dataUrl, width: frame.width, height: frame.height };
  } catch (e) {
    return { status: 'error', message: `导出 PNG 失败：${(e as Error).message}` };
  }
}
