// src/cards/features/drawing-board/layer-manager.ts
// 图层管理器：图层 CRUD + 锁定/可见/不透明度 + 图片缓存

import type { BoardLayer } from './types';
import type { DrawingBoardCard } from '../../drawing-board-card';

export class DrawingBoardLayerManager {
  private _card: DrawingBoardCard;
  layers: BoardLayer[] = [];
  selectedIndex = 0;
  private _imageCache = new Map<string, HTMLImageElement>();

  constructor(card: DrawingBoardCard) { this._card = card; }

  restore(data: { layers?: BoardLayer[]; selectedLayerIndex?: number } | null): void {
    this.layers = data?.layers || [];
    this.selectedIndex = data?.selectedLayerIndex ?? 0;
    this.layers.forEach(layer => {
      if (layer.imageData) {
        const img = new Image();
        img.onload = () => this._card._renderer.requestRender();
        img.onerror = () => { layer.imageData = null; };
        img.src = layer.imageData;
        this._imageCache.set(layer.imageData, img);
      }
    });
  }

  export(): { layers: BoardLayer[]; selectedLayerIndex: number } {
    return { layers: this.layers.map(l => ({ ...l })), selectedLayerIndex: this.selectedIndex };
  }

  getSelected(): BoardLayer | null {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.layers.length) return this.layers[this.selectedIndex];
    return null;
  }
  getSelectedIndex(): number { return this.selectedIndex; }
  setSelected(index: number): void { if (index >= 0 && index < this.layers.length) this.selectedIndex = index; }

  createLayer(name = '新图层'): BoardLayer {
    const layer: BoardLayer = {
      id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'empty', name, imageData: null,
      x: 0, y: 0, width: null, height: null,
      opacity: 1, visible: true, locked: false,
      drawings: [], texts: []
    };
    this.layers.push(layer);
    this.selectedIndex = this.layers.length - 1;
    return layer;
  }

  deleteLayer(index: number): boolean {
    if (this.layers.length <= 1 || index < 0 || index >= this.layers.length) return false;
    this.layers.splice(index, 1);
    if (this.selectedIndex >= this.layers.length) this.selectedIndex = this.layers.length - 1;
    return true;
  }

  toggleVisibility(index: number): boolean {
    if (index >= 0 && index < this.layers.length) { this.layers[index].visible = !this.layers[index].visible; return true; }
    return false;
  }

  toggleLock(index: number): boolean {
    if (index >= 0 && index < this.layers.length) { this.layers[index].locked = !this.layers[index].locked; return true; }
    return false;
  }

  swapLayers(fromIndex: number, toIndex: number): boolean {
    if (fromIndex < 0 || fromIndex >= this.layers.length || toIndex < 0 || toIndex >= this.layers.length) return false;
    const temp = this.layers[fromIndex];
    this.layers.splice(fromIndex, 1);
    this.layers.splice(toIndex, 0, temp);
    if (this.selectedIndex === fromIndex) this.selectedIndex = toIndex;
    else if (fromIndex < this.selectedIndex && toIndex >= this.selectedIndex) this.selectedIndex--;
    else if (fromIndex > this.selectedIndex && toIndex <= this.selectedIndex) this.selectedIndex++;
    return true;
  }

  setOpacity(index: number, opacity: number): boolean {
    if (index >= 0 && index < this.layers.length) { this.layers[index].opacity = Math.max(0, Math.min(1, opacity)); return true; }
    return false;
  }

  setImageLayers(imageLayers: BoardLayer[]): void {
    this.layers = imageLayers;
    if (this.layers.length > 0 && this.selectedIndex === -1) this.selectedIndex = 0;
  }

  getImage(imageData: string): HTMLImageElement | null {
    if (!imageData) return null;
    if (this._imageCache.has(imageData)) return this._imageCache.get(imageData)!;
    const img = new Image();
    img.onload = () => {
      const layer = this.layers.find(l => l.imageData === imageData);
      if (layer) { layer.width = img.naturalWidth; layer.height = img.naturalHeight; this._card._ensureCanvasFitsImage?.(layer, img); }
    };
    img.onerror = () => { this._imageCache.delete(imageData); };
    img.src = imageData;
    this._imageCache.set(imageData, img);
    return img;
  }

  preloadImages(onComplete: (() => void) | null): void {
    let loadedCount = 0;
    let totalCount = 0;
    this.layers.forEach(layer => {
      if (layer.imageData && !this._imageCache.has(layer.imageData)) {
        totalCount++;
        const img = new Image();
        img.onload = () => {
          const l = this.layers.find(ll => ll.imageData === img.src);
          if (l) { l.width = img.naturalWidth; l.height = img.naturalHeight; this._card._ensureCanvasFitsImage?.(l, img); }
          loadedCount++;
          if (onComplete && loadedCount === totalCount) onComplete();
        };
        img.onerror = () => {
          loadedCount++;
          this._imageCache.delete(layer.imageData!);
          if (onComplete && loadedCount === totalCount) onComplete();
        };
        img.src = layer.imageData;
        this._imageCache.set(layer.imageData, img);
      }
    });
    if (onComplete && totalCount === 0) onComplete();
  }

  clearCache(): void { this._imageCache.clear(); }
}