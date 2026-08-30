// src/v1/nodes/port-types.ts
// 端口类型契约（A-3）：只读注册表 —— NodeType → 输入/输出数据类型（轻量版，不扩展 NodeDefinition）。
// 数据类型五类（见 docs/重构-增量架构设计 §3.3）：Image / ImageList / Text / TextList / GenerationConfig。
// 唯一连线校验入口不变（flow-state.canConnect）：内部「基础校验 → canConnectByPort 查表 → 保留特例 → 防环」。
// 阶段 D 才是可扩展注册表完整版；本文件只做只读表，改动最小、行为不退化。

/** 节点端口声明：inputs=可接收的输入类型（空数组=不接受输入）；outputs=可输出的类型（多态：image-gen 单图/批量都输出） */
export interface PortDecl {
  inputs: PortType[];
  outputs: PortType[];
}

/** 五类数据类型 → 现有 NodeType 映射（只读表，不改动节点定义） */
export const PORT_TYPES: Record<NodeType, PortDecl> = {
  'image-gen':  { inputs: ['Text', 'TextList', 'Image', 'ImageList'], outputs: ['Image', 'ImageList'] },
  'text-gen':   { inputs: ['Image', 'Text'],                          outputs: ['Text'] },
  'text-split': { inputs: ['Text'],                                   outputs: ['TextList'] },
  // 4.2-C：video-gen 可显式接收音频节点（音轨/配音参考）；是否消费由模型 capability 门控（run-engine 运行前校验）
  'video-gen':  { inputs: ['Text', 'Image', 'ImageList', 'Audio'],    outputs: ['Video'] },
  'audio-gen':  { inputs: ['Text', 'Image'],                          outputs: ['Audio'] },
};

/** 输出类型解析：素材节点（isAsset image-gen/audio-gen/video-gen）只有对应单一媒体输出（链首数据） */
export function outputTypesOf(node: FlowNode): PortType[] {
  if (node.isAsset === true) {
    if (node.type === 'audio-gen') return ['Audio'];
    if (node.type === 'video-gen') return ['Video'];
    return ['Image'];
  }
  return PORT_TYPES[node.type]?.outputs ?? [];
}

/**
 * 查表校验：返回 null=兼容，否则为拒绝原因（含类型明细）。
 * 调用方（flow-state.canConnect）在其之前保留现状特例，在其之后做防环。
 */
export function canConnectByPort(from: FlowNode, to: FlowNode): string | null {
  const outs = outputTypesOf(from);
  const ins = PORT_TYPES[to.type]?.inputs ?? [];
  if (ins.length === 0) return `${to.title} 不接受输入`;
  if (!outs.some(t => ins.includes(t))) {
    return `类型不兼容：${from.title}(${outs.join('/')}) → ${to.title}(${ins.join('/')})`;
  }
  return null;
}
