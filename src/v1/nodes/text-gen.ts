// src/v1/nodes/text-gen.ts
// 「文本」节点定义：卡片显示文本结果（outputText），单击只选中，双击卡片文本才进入就地编辑；
// 下方命令框输入处理指令（命令），文本模型按命令处理当前文本 → 结果写回卡片。
// 运行链路：run-engine 按类型分派 → runTextGen（同步调 Backend.chatV2，无批次/无轮询/无产出节点）
// 反推归位：文本节点有图片上游（素材/自建 imageUrl）时，runTextGen 自动把 data:image 图附带进 chatV2
//   （反推命令由用户在文本节点指令框输入，不再是 image-gen 上的反推开关；textModel 字段保留但无 UI 入口）。
// 联动：结果变化 → dirty.markUpstreamChanged 标全下游 stale（旁路已删除，不覆盖下游 prompt；见架构 3.2）

import { nodeRegistry } from './node-registry';

/** 节点级文本历史上限（跨文件共享约定：不硬编码） */
export const TEXT_HISTORY_LIMIT = 20;

/** chat 默认模型 localStorage key（与绘图 icv_default_model 区分，互不污染） */
export const DEFAULT_CHAT_MODEL_KEY = 'icv_default_chat_model';

const def: NodeDefinition = {
  type: 'text-gen',
  label: '文本',
  defaultTitle: '文本',
  defaultRatio: 4 / 3,
  defaultParams: {
    instruction: '', // 命令：临时输入，新建为空、发送后清空
    model: '',
  },

  // 命令驱动：需要已选文本模型 + 命令非空；无参考图要求
  canRun(node: FlowNode, _ctx: FlowContext): boolean | string {
    const p = node.params as unknown as TextGenParams;
    if (!p.model) return '请先选择文本模型';
    if (!p.instruction || !p.instruction.trim()) return '请输入命令';
    return true;
  },

  buildOptions(node: FlowNode, _ctx: FlowContext): Record<string, unknown> {
    const p = node.params as unknown as TextGenParams;
    return {
      model: p.model || undefined,
    };
  },
};

nodeRegistry.register(def);
