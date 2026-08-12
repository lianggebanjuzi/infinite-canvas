// src/v1/nodes/style-transfer.ts
// ② 换风格节点定义：prompt + 模型参数 + 参考图=上游 image，输出 image

import { nodeRegistry } from './node-registry';

const def: NodeDefinition = {
  type: 'style-transfer',
  label: '换风格',
  defaultTitle: '北欧风场景',
  defaultRatio: 3 / 4,
  defaultParams: {
    prompt: '',
    model: '',
    aspectRatio: '3:4',
    resolution: '2k',
    count: 1,
  },

  canRun(node: FlowNode, ctx: FlowContext): boolean | string {
    const p = node.params as unknown as StyleTransferParams;
    if (!p.prompt || !p.prompt.trim()) return '请输入风格指令';
    if (!p.model) return '请先选择绘图模型';
    const upstream = ctx.getUpstreams(node.id)[0];
    if (!upstream) return '请先连接上游产品图';
    if (!upstream.imageUrl) return '上游产品图尚未选择图片';
    return true;
  },

  buildOptions(node: FlowNode, ctx: FlowContext): Record<string, unknown> {
    const p = node.params as unknown as StyleTransferParams;
    const upstream = ctx.getUpstreams(node.id)[0];
    const referenceImages = upstream?.imageUrl ? [upstream.imageUrl] : [];
    return {
      model: p.model || undefined,
      aspectRatio: p.aspectRatio || 'Auto',
      resolution: p.resolution || '1k',
      count: p.count || 1,
      referenceImages,
    };
  },
};

nodeRegistry.register(def);
