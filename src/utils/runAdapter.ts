import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';

export class RunDebugAdapter implements vscode.DebugAdapter {
    private _sendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this._sendMessage.event;

    constructor(private process: ChildProcess) {
        if (process) {
            process.on('exit', () => {
                this._sendMessage.fire({
                    type: 'event',
                    event: 'terminated',
                    seq: 0
                } as any);
            });
        }
    }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        const msg = message as any;
        if (msg.command === 'initialize') {
            this._sendMessage.fire({
                type: 'response',
                command: 'initialize',
                request_seq: msg.seq,
                success: true,
                body: {
                    supportsTerminateRequest: true
                }
            } as any);
        } else if (msg.command === 'launch') {
            this._sendMessage.fire({
                type: 'response',
                command: 'launch',
                request_seq: msg.seq,
                success: true
            } as any);
            this._sendMessage.fire({
                type: 'event',
                event: 'initialized',
                seq: 0
            } as any);
        } else if (msg.command === 'disconnect' || msg.command === 'terminate') {
            if (this.process && !this.process.killed) {
                this.process.kill();
            }
            this._sendMessage.fire({
                type: 'response',
                command: msg.command,
                request_seq: msg.seq,
                success: true
            } as any);
        } else if (msg.command === 'configurationDone') {
            this._sendMessage.fire({
                type: 'response',
                command: 'configurationDone',
                request_seq: msg.seq,
                success: true
            } as any);
        }
    }

    dispose() {
        if (this.process && !this.process.killed) {
            this.process.kill();
        }
    }
}

export class RunDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    private process?: ChildProcess;

    constructor(process?: ChildProcess) {
        this.process = process;
    }

    setProcess(process: ChildProcess) {
        this.process = process;
    }

    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(new RunDebugAdapter(this.process!));
    }
}