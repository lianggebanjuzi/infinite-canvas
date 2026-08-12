// src/v1/nodes/node-registry.ts
// 注册式节点定义表：type → NodeDefinition
// 新增节点 = 注册一个定义（见架构文档「七、共享约定」第 9 条）

class NodeRegistry {
  private defs = new Map<NodeType, NodeDefinition>();

  register(def: NodeDefinition): void {
    this.defs.set(def.type, def);
  }

  get(type: NodeType): NodeDefinition {
    const def = this.defs.get(type);
    if (!def) throw new Error(`未知节点类型: ${type}`);
    return def;
  }

  has(type: NodeType): boolean {
    return this.defs.has(type);
  }

  list(): NodeDefinition[] {
    return [...this.defs.values()];
  }
}

export const nodeRegistry = new NodeRegistry();
