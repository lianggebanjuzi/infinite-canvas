// src/v1/nodes/image-result.ts
// 「生成结果」结果卡定义：只读结果载体，由 run-engine 在生成节点批次成功后自动创建并连线
// 职责：只展示 imageUrl、可作 from 喂下游参考图、可手动删、入历史图库
// 约束：无入端口（canConnect 拒绝 to）、无参数、无参考图缩略行、无运行菜单项、不进新建菜单

import { nodeRegistry } from './node-registry';

const def: NodeDefinition = {
  type: 'image-result',
  label: '生成结果',
  defaultTitle: '生成结果',
  defaultRatio: 3 / 4,
  defaultParams: {},
  creatable: false, // 不进新建菜单（拖线新建/画布右键均不可手动创建）

  canRun(_node: FlowNode, _ctx: FlowContext): boolean | string {
    return '结果卡为只读，不能运行';
  },

  buildOptions(_node: FlowNode, _ctx: FlowContext): Record<string, unknown> {
    return {};
  },
};

nodeRegistry.register(def);
