// src/cards/features/drawing-board/types.ts
// DrawingBoard 模块共享类型

export interface BrushSettings {
  size: number;
  hardness: number;
  color: string;
  opacity: number;
  [key: string]: unknown;
}

export interface EraserSettings {
  size: number;
  [key: string]: unknown;
}

export interface TextSettings {
  fontSize: number;
  color: string;
  fontFamily: string;
  [key: string]: unknown;
}

export interface DrawingLayer {
  points: Array<{ x: number; y: number }>;
  color: string;
  size: number;
  opacity: number;
  hardness?: number;
}

export interface TextItem {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  fontFamily: string;
}

export interface BoardLayer {
  id: string;
  type: string;
  name: string;
  imageData: string | null;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  opacity: number;
  visible: boolean;
  locked: boolean;
  drawings: DrawingLayer[];
  texts: TextItem[];
}

export interface CanvasConfig {
  width: number;
  height: number;
}