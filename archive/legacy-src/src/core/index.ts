// src/core/index.ts
// 聚合导出 + window 桥接
export { Command, CompoundCommand } from './command-base';
export { CmdManager } from './command-manager';
export { History } from './history';
export { UndoRedo } from './undo-redo';
export { SnapshotCollector } from './snapshot';
export { Storage } from './storage';
export { Canvas } from './canvas';
export { Clipboard } from './clipboard';
export {
    CreateCardCommand, DeleteCardsCommand, MoveCardsCommand,
    PropertyChangeCommand, ProjectNameCommand, ModifyContentCommand,
    CreateConnectionCommand, RemoveConnectionCommand,
    CreateGroupCommand, DeleteGroupCommand, GroupPropertyCommand,
    PasteCommand,
} from './commands';
