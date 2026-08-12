// src/v1/nodes/image-gen.ts
// ③ 图片生成节点定义：多张上游图 + 指令 → 生成一张新图
// 与 style-transfer 的区别：referenceImages 取【全部】上游图（数组），canRun 要求"至少一个上游有图"

import { nodeRegistry } from './node-registry';

const def: NodeDefinition = {
  type: 'image-gen',
  label: '图片生成',
  defaultTitle: '图片生成',
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
    if (!p.prompt || !p.prompt.trim()) return '请输入生成指令';
    if (!p.model) return '请先选择绘图模型';
    const upstreams = ctx.getUpstreams(node.id).filter(u => u.imageUrl);
    if (upstreams.length === 0) return '请先连接至少一个带图的上游节点';
    return true;
  },

  buildOptions(node: FlowNode, ctx: FlowContext): Record<string, unknown> {
    const p = node.params as unknown as StyleTransferParams;
    // 多图参考：取全部上游节点的图（有图才纳入），顺序与上游一致
    const referenceImages = ctx.getUpstreams(node.id)
      .filter(u => u.imageUrl)
      .map(u => u.imageUrl as string);
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
