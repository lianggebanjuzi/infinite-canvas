// src/v1/nodes/text-gen.ts
// 「文本反推」节点定义：挂参考图 → 反推该图的提示词（chat 模型）→ 输出文本（outputText）
// 运行链路：run-engine 按类型分派 → runTextGen（同步调 Backend.chatV2，无批次/无轮询/无结果卡）
// 联动：反推成功 → 直接 image-gen 下游的 params.prompt 被覆盖为新文本 → 下游标 stale（见架构 5.2）

import { nodeRegistry } from './node-registry';

/** 节点级文本历史上限（跨文件共享约定：不硬编码） */
export const TEXT_HISTORY_LIMIT = 20;

/** 默认反推指令（用户可编辑） */
export const DEFAULT_INSTRUCTION = '反推这张图的提示词，中文，输出可直接用于生图';

/** chat 默认模型 localStorage key（与绘图 icv_default_model 区分，互不污染） */
export const DEFAULT_CHAT_MODEL_KEY = 'icv_default_chat_model';

const def: NodeDefinition = {
  type: 'text-gen',
  label: '文本反推',
  defaultTitle: '文本反推',
  defaultRatio: 3 / 4,
  defaultParams: {
    instruction: DEFAULT_INSTRUCTION,
    model: '',
  },

  // 用户拍板：必须有参考图才能运行（覆盖架构师"推荐允许无图"）
  canRun(node: FlowNode, ctx: FlowContext): boolean | string {
    const p = node.params as unknown as TextGenParams;
    if (!p.instruction || !p.instruction.trim()) return '请输入反推指令';
    if (!p.model) return '请先选择对话模型';
    const refs = ctx.getReferenceImages(node.id);
    if (!refs || refs.length === 0) return '请先连接一张图片或添加参考图';
    return true;
  },

  buildOptions(node: FlowNode, ctx: FlowContext): Record<string, unknown> {
    const p = node.params as unknown as TextGenParams;
    return {
      model: p.model || undefined,
      images: ctx.getReferenceImages(node.id), // chat_v2 只收 data:image 前缀；当前参考图恒为 data URL
    };
  },
};

nodeRegistry.register(def);
