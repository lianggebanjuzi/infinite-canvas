// 视频生成节点：能力与请求参数均由 model-config / 后端 VideoAPI 决定。
import { nodeRegistry } from './node-registry';
import { getVideoModelCapabilities } from './model-config';

const def: NodeDefinition = {
  type: 'video-gen', label: '视频生成', defaultTitle: '视频生成', defaultRatio: 16 / 9,
  defaultParams: { prompt: '', model: '', seconds: 5, aspectRatio: '16:9', resolution: '720p', audio: false },
  canRun(node: FlowNode, ctx: FlowContext): boolean | string {
    const p = node.params as unknown as VideoGenParams;
    const hasPrompt = !!p.prompt?.trim() || ctx.getUpstreams(node.id)
      .some(u => u.type === 'text-gen' && !!u.outputText?.trim());
    if (!hasPrompt) return '请输入视频提示词或连接文本节点';
    if (!p.model) return '请先选择视频模型';
    const caps = getVideoModelCapabilities(p.model);
    if (!caps.available) return '当前视频模型未声明可用能力';
    if (ctx.getReferenceImages(node.id).length && !caps.supportsImageReference) return '当前视频模型不支持图片参考';
    return true;
  },
  buildOptions(node: FlowNode, ctx: FlowContext): Record<string, unknown> {
    const p = node.params as unknown as VideoGenParams;
    const caps = getVideoModelCapabilities(p.model);
    return {
      model: p.model,
      seconds: caps.seconds.includes(Number(p.seconds)) ? Number(p.seconds) : caps.seconds[0],
      aspectRatio: caps.aspectRatios.includes(p.aspectRatio) ? p.aspectRatio : caps.aspectRatios[0],
      resolution: caps.resolutions.includes(p.resolution) ? p.resolution : caps.resolutions[0],
      audio: caps.supportsAudio ? !!p.audio : undefined,
      referenceImages: caps.supportsImageReference ? ctx.getReferenceImages(node.id) : [],
    };
  },
};

nodeRegistry.register(def);
