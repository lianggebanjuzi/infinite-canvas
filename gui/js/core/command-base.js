/**
 * 命令模式基类
 * 所有撤销/重做操作都继承此类
 *
 * 设计原则：
 * - execute() 执行操作（正向）
 * - undo()    撤销操作（反向，必须精确还原到执行前的状态）
 * - redo()    重做操作（重新执行正向操作，默认调用 execute）
 */
class Command {

    /**
     * @param {string} type  - 命令类型标识（用于调试和序列化）
     * @param {string} [label] - 用户可见的操作描述（如 "移动卡片"、"删除卡片"）
     */
    constructor(type, label = '') {
        this.type = type;
        this.label = label || type;
        this.timestamp = Date.now();
    }

    /** 正向执行（子类必须实现） */
    execute() {
        throw new Error('子类必须实现 execute()');
    }

    /** 反向撤销（子类必须实现） */
    undo() {
        throw new Error('子类必须实现 undo()');
    }

    /** 重做（默认等同于重新 execute，可覆写） */
    redo() {
        return this.execute();
    }
}


/**
 * 复合命令（宏命令）
 * 将多个原子命令打包成一个逻辑操作
 * 典型场景：粘贴 10 张卡片 + 它们之间的连线 → 一个 CompoundCommand
 *
 * 用法：
 *   const compound = new CompoundCommand('粘贴', [
 *     new CreateCardCommand(...),
 *     new CreateCardCommand(...),
 *     new ConnectionCommand(...)
 *   ]);
 *   compound.execute();  // 按顺序执行所有子命令
 *   compound.undo();     // 反向撤销所有子命令
 */
class CompoundCommand extends Command {

    constructor(label = '复合操作', commands = []) {
        super('compound', label);
        this.commands = commands;
    }

    /** 添加子命令（链式） */
    add(command) {
        this.commands.push(command);
        return this;
    }

    /** 按顺序执行所有子命令 */
    execute() {
        for (const cmd of this.commands) {
            cmd.execute();
        }
    }

    /** 反向撤销所有子命令（逆序） */
    undo() {
        for (let i = this.commands.length - 1; i >= 0; i--) {
            this.commands[i].undo();
        }
    }

    /** 子命令数 */
    get size() {
        return this.commands.length;
    }
}

window.Command = Command;
window.CompoundCommand = CompoundCommand;
