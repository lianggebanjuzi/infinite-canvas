// src/v1/nodes/image-gen.ts
// 统一「生成节点」定义：多张参考图（refImages ∪ 上游可作参考图的图）+ 提示词 → 生成一张新图
// 参考图 0~N 可选（0 张时为纯文生图），参考图合并统一走 FlowContext.getReferenceImages
// 双卡模型：引擎图生图产出的新节点也注册本类型（parentId 标记归属），与手建节点同样可编辑/可反推/可连线

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
    // 文本模型反推模式：需已选文本模型 + 命令 + 有图
    if (p.modelType === 'text') {
      if (!p.textModel) return '请先选择文本模型';
      if (!p.prompt || !p.prompt.trim()) return '请输入命令';
      const img = node.imageUrl || ctx.getReferenceImages(node.id)[0];
      if (!img) return '请先有图片';
      return true;
    }
    if (!p.prompt || !p.prompt.trim()) return '请输入提示词';
    if (!p.model) return '请先选择绘图模型';
    return true; // 参考图 0~N 可选
  },

  buildOptions(node: FlowNode, ctx: FlowContext): Record<string, unknown> {
    const p = node.params as unknown as StyleTransferParams;
    return {
      model: p.model || undefined,
      aspectRatio: p.aspectRatio || 'Auto',
      resolution: p.resolution || '1k',
      count: p.count || 1,
      referenceImages: ctx.getReferenceImages(node.id),
    };
  },
};

nodeRegistry.register(def);
