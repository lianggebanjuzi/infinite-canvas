/**
 * 迁移期命令类声明。
 * 命令由 src/core/commands.ts 实现，并通过 bridge.ts 暴露到 window。
 * 暂时保留宽泛构造类型，供尚未改为模块导入的调用点使用。
 */
declare const PropertyChangeCommand: Function;
declare const MoveCardsCommand: Function;
declare const DeleteCardsCommand: Function;
declare const CreateCardCommand: Function;
declare const CreateConnectionCommand: Function;
declare const RemoveConnectionCommand: Function;
declare const CreateGroupCommand: Function;
declare const DeleteGroupCommand: Function;
declare const GroupPropertyCommand: Function;
declare const ModifyContentCommand: Function;
