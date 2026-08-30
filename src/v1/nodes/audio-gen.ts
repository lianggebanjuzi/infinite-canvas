// 音频生成节点：能力与请求参数均由 model-config / 后端 AudioAPI 决定（4.2-B）。
// 未配置音频模型（能力表 available:false）时不出现可运行按钮；导入的本地音频素材复用本类型 + isAsset:true。
import { nodeRegistry } from './node-registry';
import { getAudioModelCapabilities } from './model-config';
import { flowState } from '../state/flow-state';

const def: NodeDefinition = {
  type: 'audio-gen',
  label: '音频生成',
  defaultTitle: '音频生成',
  defaultRatio: 16 / 9,
  defaultParams: { prompt: '', model: '', seconds: 10, format: 'mp3' },

  canRun(node: FlowNode, ctx: FlowContext): boolean | string {
    if (flowState.isAssetNode(node)) return '素材节点不可运行';
    const p = node.params as unknown as AudioGenParams;
    const hasPrompt = !!p.prompt?.trim() || ctx.getUpstreams(node.id)
      .some(u => u.type === 'text-gen' && !!u.outputText?.trim());
    if (!hasPrompt) return '请输入音频提示词或连接文本节点';
    if (!p.model) return '请先选择音频模型';
    const caps = getAudioModelCapabilities(p.model);
    if (!caps.available) return '未配置音频模型，请先在设置中配置';
    if (ctx.getReferenceImages(node.id).length && !caps.supportsImageConditioning) return '当前音频模型不支持图片条件音频';
    return true;
  },

  buildOptions(node: FlowNode, ctx: FlowContext): Record<string, unknown> {
    const p = node.params as unknown as AudioGenParams;
    const caps = getAudioModelCapabilities(p.model);
    const seconds = caps.seconds.length > 0 && caps.seconds.includes(Number(p.seconds))
      ? Number(p.seconds)
      : (caps.seconds[0] ?? undefined);
    const format = caps.formats.includes(p.format ?? 'mp3')
      ? (p.format ?? 'mp3')
      : caps.formats[0];
    return {
      model: p.model,
      ...(typeof seconds === 'number' ? { seconds } : {}),
      format,
      // 图片条件音频仅在模型 capability 明确支持时开放（4.0 §3.4 能力门控）
      referenceImages: caps.supportsImageConditioning ? ctx.getReferenceImages(node.id) : [],
    };
  },
};

nodeRegistry.register(def);
