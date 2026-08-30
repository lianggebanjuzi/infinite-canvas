// 文本节点执行：同步 chat_v2，不参与图片批次或媒体轮询。
import { Backend } from '../api';
import { linkView } from '../canvas/link-view';
import { historyPersist } from '../history-persist';
import { nodeRegistry } from '../nodes/node-registry';
import { dirty } from '../state/dirty';
import { flowState } from '../state/flow-state';
import { showToast } from '../ui/toast';
import type { ActiveRun } from './media-task-recovery';

export interface TextGenerationHost {
  context: FlowContext;
  isActive: (active: ActiveRun) => boolean;
}

/**
 * 文本处理执行（text-gen 专用）：命令驱动，同步调 chat_v2，无批次/无轮询/无产出节点。
 * RunEngine 仍拥有活动任务及撤销历史生命周期；本控制器只处理文本节点自身执行语义。
 */
export class TextGenerationController {
  constructor(private readonly host: TextGenerationHost) {}

  async run(nodeId: string, active: ActiveRun): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;

    // 1. 启动时快照命令与当前输出文本（buildOptions 只取一次，仅含 model）
    const params = node.params as unknown as TextGenParams;
    const command = (params.instruction || '').trim();
    const currentText = (node.outputText || '').trim();
    const def = nodeRegistry.get(node.type);
    const options = def.buildOptions(node, this.host.context);

    // 1.5 反推归位：接入上游图（getReferenceImages 取直接上游 imageUrl 一层；data:image 过滤 + 前置校验 W2-4）
    const refs = flowState.getReferenceImages(nodeId);
    if (refs.length > 0) {
      const dataImages = refs.filter(u => u.startsWith('data:image'));
      if (dataImages.length === 0) {
        flowState.updateNode(nodeId, { status: 'fail', error: '图片格式不支持反推' });
        showToast('图片格式不支持反推', false);
        return;
      }
      options.images = dataImages;
    }

    // 2. 置 run + 上游连线流光
    flowState.updateNode(nodeId, { status: 'run', error: null });
    linkView.setNodeFlowing(nodeId, true);

    try {
      // 3. 同步阻塞调用 chat_v2：system 固定文案，user 按「有无原文」拼装
      const system = '你是电商视觉文案处理助手，只输出处理后的文本，不要解释、不要引号';
      const user = currentText ? `原文：\n${currentText}\n\n指令：${command}` : command;
      const res = await Backend.chatV2(user, { ...options, metaPrompt: system });
      if (!this.host.isActive(active)) return;
      const text = (res.text || '').trim();
      if (!text) throw new Error('处理结果为空');

      // 4. 成功：写回输出文本 + 历史 + 标下游 stale（旁路已删除：不再覆盖下游 prompt，W3-1）
      flowState.updateNode(nodeId, { status: 'done', outputText: text, error: null, lastRunAt: Date.now() });
      flowState.pushTextHistory(nodeId, text);
      dirty.markUpstreamChanged(nodeId);
      // 文本 trace：node.trace 恒 null（类型定义如此），但仍追加一条 kind:'text' 流水
      void historyPersist.appendTrace(historyPersist.buildTextTrace(node));
      showToast('已完成');
    } catch (e) {
      if (!this.host.isActive(active)) return;
      // 5. 失败：fail + 原因；不写历史
      const message = (e as Error).message || '处理失败';
      flowState.updateNode(nodeId, { status: 'fail', error: message });
      showToast(message, false);
    } finally {
      if (!this.host.isActive(active)) return;
      linkView.setNodeFlowing(nodeId, false);
      // 保留文本命令：无论成功还是失败，用户都可直接修改后重试。
    }
  }
}
