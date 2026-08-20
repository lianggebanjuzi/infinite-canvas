// 文本拆分：不请求后端。用户可编辑槽位；其下游图片节点按非空槽位逐张生成。
import { nodeRegistry } from './node-registry';

const def: NodeDefinition = {
  type: 'text-split',
  label: '文本拆分',
  defaultTitle: '文本拆分',
  defaultRatio: 0.72,
  defaultParams: { delimiter: '########', segments: ['', ''] },
  canRun(): boolean | string { return true; },
  buildOptions(): Record<string, unknown> { return {}; },
};

nodeRegistry.register(def);
