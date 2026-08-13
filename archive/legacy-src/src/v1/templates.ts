// src/v1/templates.ts
// 内置模板：统一「生成节点」两段流水线默认布局 + 连线 + 默认参数
// 默认：生成节点A（挂产品图 + 提示词）→ 生成节点B

import { uid } from '../utils/uid';

/** 创建默认模板项目（A1：由空态引导按钮触发，不自动加载） */
export function createDefaultProject(): FlowProject {
  const now = Date.now();

  const nodeA: FlowNode = {
    id: uid('node'),
    type: 'image-gen',
    x: 60,
    y: 180,
    ratio: 3 / 4,
    status: 'idle',
    title: '生成节点A',
    params: {
      prompt: '生成一张产品主图，浅灰背景',
      model: '',
      aspectRatio: '3:4',
      resolution: '2k',
      count: 1,
    },
    imageUrl: null,
    refImages: [],
    error: null,
    lastRunAt: null,
  };

  const nodeB: FlowNode = {
    id: uid('node'),
    type: 'image-gen',
    x: 430,
    y: 180,
    ratio: 3 / 4,
    status: 'idle',
    title: '生成节点B',
    params: {
      prompt: '基于上游产品图，把背景换成浅灰水泥墙，加一盆绿萝',
      model: '',
      aspectRatio: '3:4',
      resolution: '2k',
      count: 1,
    },
    imageUrl: null,
    refImages: [],
    error: null,
    lastRunAt: null,
  };

  return {
    format: 'icv',
    version: '3.1',
    projectName: '未命名项目',
    canvas: { scale: 1, panX: 60, panY: 40 },
    nodes: [nodeA, nodeB],
    edges: [{ id: uid('edge'), from: nodeA.id, to: nodeB.id }],
    createdAt: now,
    updatedAt: now,
  };
}
