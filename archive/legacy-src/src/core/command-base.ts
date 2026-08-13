// src/core/command-base.ts
// 命令模式基类 + 复合命令
import { AppState } from '../state/app-state';

export class Command {
    type: string;
    label: string;
    timestamp: number;

    constructor(type: string, label: string = '') {
        this.type = type;
        this.label = label || type;
        this.timestamp = Date.now();
    }

    execute(..._args: unknown[]): void {
        throw new Error('子类必须实现 execute()');
    }

    undo(): void {
        throw new Error('子类必须实现 undo()');
    }

    redo(): void {
        return this.execute();
    }
}

export class CompoundCommand extends Command {
    commands: Command[] = [];

    constructor(label = '复合操作', commands: Command[] = []) {
        super('compound', label);
        this.commands = commands;
    }

    add(command: Command): this {
        this.commands.push(command);
        return this;
    }

    execute(..._args: unknown[]): void {
        for (const cmd of this.commands) {
            cmd.execute();
        }
    }

    undo(): void {
        for (let i = this.commands.length - 1; i >= 0; i--) {
            this.commands[i].undo();
        }
    }

    get size(): number {
        return this.commands.length;
    }
}

(window as unknown as {
    Command: typeof Command;
    CompoundCommand: typeof CompoundCommand;
}).Command = Command;
(window as unknown as { CompoundCommand: typeof CompoundCommand }).CompoundCommand = CompoundCommand;
