// src/v1/nodes/image-gen.ts
// 统一「生成节点」定义：多张参考图（refImages ∪ 上游可作参考图的图）+ 提示词 → 生成一张新图
// 参考图 0~N 可选（0 张时为纯文生图），参考图合并统一走 FlowContext.getReferenceImages
// 双卡模型：引擎图生图产出的新节点也注册本类型（parentId 标记归属），与手建节点同样可编辑/可连线
// 素材态（isAsset）：复用本类型 + 顶层 isAsset:true 标记（Q3）——整卡显图、不可运行、无指令面板、可作 from 连线
// 旧 modelType='text' 反推分支已删除（Q7）：运行时忽略、一律按 draw 处理；反推归位到文本节点（runTextGen 带上游图）

import { nodeRegistry } from './node-registry';
import { flowState } from '../state/flow-state';
import { isGeminiImageModel } from '../api';
import { isModelRuntimeSupported } from './model-config';

const def: NodeDefinition = {
  type: 'image-gen',
  label: '图片生成',
  defaultTitle: '图片生成',
  defaultRatio: 4 / 3,
  defaultParams: {
    prompt: '',
    model: '',
    aspectRatio: '4:3',
    resolution: '2k',
    count: 1,
  },

  canRun(node: FlowNode, ctx: FlowContext): boolean | string {
    // 素材节点：仅展示、不可运行（数据层闸门；右键菜单/指令面板入口另行隐藏）
    if (flowState.isAssetNode(node)) return '素材节点不可运行';
    const p = node.params as unknown as StyleTransferParams;
    if (p.mode === 'outpaint') {
      if (ctx.getReferenceImages(node.id).length === 0) return '扩图节点需要连接一张源图片';
      if (!p.model) return '请先选择可用的扩图模型';
      if (!isGeminiImageModel(p.model)) return '扩图请使用 Nano Banana、Gemini 或 Seedream 模型';
      return true;
    }
    // draw 放宽（W3-3）：自身 prompt 空但有文本上游 → 允许运行（文本走线：上游文本作关键词）；
    // 两者皆空 → 拒绝「请输入提示词」。
    const hasOwnPrompt = !!(p.prompt && p.prompt.trim());
    const hasUpstreamText = ctx.getUpstreams(node.id)
      .some(u => u.type === 'text-gen' && typeof u.outputText === 'string' && u.outputText.trim().length > 0);
  // 与实际执行时保持一致：文本拆分节点可能由上游文本动态生成槽位，
  // 此时不能只检查它保存的手动 segments。
  const hasSplitText = ctx.getUpstreams(node.id)
    .some(u => u.type === 'text-split' && flowState.getTextSplitSegments(u.id).length > 0);
    if (!hasOwnPrompt && !hasUpstreamText && !hasSplitText) return '请输入提示词';
    if (!p.model) return '请先选择绘图模型';
    if (!isModelRuntimeSupported(p.model, 'drawing')) return '当前模型的自定义声明式适配器尚未接入实际生成';
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
