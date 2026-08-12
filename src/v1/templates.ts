// src/v1/templates.ts
// 内置模板：2 步流水线默认布局 + 连线 + 默认参数
// 首版仅「产品图 → 换风格」；第二版可扩展为 产品图 → 换风格 → 细节特写

import { uid } from '../utils/uid';

/** 创建默认模板项目（A1：由空态引导按钮触发，不自动加载） */
export function createDefaultProject(): FlowProject {
  const now = Date.now();

  const product: FlowNode = {
    id: uid('node'),
    type: 'product-image',
    x: 60,
    y: 180,
    ratio: 3 / 4,
    status: 'idle',
    title: '产品图',
    params: {},
    imageUrl: null,
    error: null,
    lastRunAt: null,
  };

  const style: FlowNode = {
    id: uid('node'),
    type: 'style-transfer',
    x: 430,
    y: 180,
    ratio: 3 / 4,
    status: 'idle',
    title: '北欧风场景',
    params: {
      prompt: '把背景换成浅灰水泥墙，加一盆绿萝',
      model: '',
      aspectRatio: '3:4',
      resolution: '2k',
      count: 1,
    },
    imageUrl: null,
    error: null,
    lastRunAt: null,
  };

  return {
    format: 'icv',
    version: '3.0',
    projectName: '未命名项目',
    canvas: { scale: 1, panX: 60, panY: 40 },
    nodes: [product, style],
    edges: [{ id: uid('edge'), from: product.id, to: style.id }],
    createdAt: now,
    updatedAt: now,
  };
}
