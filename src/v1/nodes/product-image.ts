// src/v1/nodes/product-image.ts
// ① 输入产品图节点定义：选图/拖图/替换，输出 image（画布数据源）

import { nodeRegistry } from './node-registry';

const def: NodeDefinition = {
  type: 'product-image',
  label: '产品图',
  defaultTitle: '产品图',
  defaultRatio: 3 / 4,
  defaultParams: {},

  /** 输入节点本身不生成：有图即视为可运行（run 时直接置 done） */
  canRun(node: FlowNode): boolean | string {
    return node.imageUrl ? true : '请先选择产品图';
  },

  buildOptions(): Record<string, unknown> {
    return {};
  },
};

nodeRegistry.register(def);
