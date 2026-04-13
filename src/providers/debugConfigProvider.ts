import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { debugCommand } from '../commands/debug';
import { isCosmosProject } from '../utils/project';

/**
 * Provides "Cosmos: Debug Kernel" in the Run and Debug dropdown and handles
 * launch resolution by delegating to the existing QEMU + cppdbg flow.
 */
export class CosmosDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(
        folder: vscode.WorkspaceFolder | undefined,
        token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return [
            {
                name: 'Cosmos: Debug Kernel',
                type: 'cosmos-debug',
                request: 'launch'
            }
        ];
    }

    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration | undefined> {
        // If config is empty (user pressed F5 with no launch.json and picked
        // cosmos-debug, or we auto-selected), fill in the type so the adapter
        // factory is invoked.
        if (!config.type) {
            if (!isCosmosProject()) {
                return undefined;
            }
            config.type = 'cosmos-debug';
            config.name = 'Cosmos: Debug Kernel';
            config.request = 'launch';
        }

        return config;
    }
}

/**
 * Inline debug adapter for cosmos-debug. On "launch" it kicks off the real
 * debugCommand() (QEMU + cppdbg) and then immediately terminates itself so
 * only the cppdbg session remains visible.
 */
export class CosmosDebugAdapter implements vscode.DebugAdapter {
    private _sendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this._sendMessage.event;

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
            // Respond to launch immediately
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

            // Start the real debug flow (QEMU + cppdbg), then terminate this
            // placeholder session
            debugCommand().finally(() => {
                this._sendMessage.fire({
                    type: 'event',
                    event: 'terminated',
                    seq: 0
                } as any);
            });
        } else if (msg.command === 'configurationDone') {
            this._sendMessage.fire({
                type: 'response',
                command: 'configurationDone',
                request_seq: msg.seq,
                success: true
            } as any);
        } else if (msg.command === 'disconnect' || msg.command === 'terminate') {
            this._sendMessage.fire({
                type: 'response',
                command: msg.command,
                request_seq: msg.seq,
                success: true
            } as any);
        }
    }

    dispose() { }
}

export class CosmosDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(new CosmosDebugAdapter());
    }
}

/**
 * Ensures .vscode/launch.json contains the Cosmos debug configuration.
 * Called once during activation for Cosmos projects.
 */
export function ensureLaunchJson(workspaceFolder: vscode.WorkspaceFolder): void {
    const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
    const launchPath = path.join(vscodeDir, 'launch.json');

    const cosmosConfig = {
        name: 'Cosmos: Debug Kernel',
        type: 'cosmos-debug',
        request: 'launch'
    };

    if (fs.existsSync(launchPath)) {
        try {
            // Strip single-line // comments (but not inside strings) before parsing
            const raw = fs.readFileSync(launchPath, 'utf8');
            const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
            const launch = JSON.parse(stripped);
            const configs: any[] = launch.configurations || [];
            const hasCosmosDebug = configs.some(
                (c: any) => c.type === 'cosmos-debug'
            );
            if (!hasCosmosDebug) {
                configs.push(cosmosConfig);
                launch.configurations = configs;
                fs.writeFileSync(launchPath, JSON.stringify(launch, null, 4) + '\n');
            }
        } catch {
            // Malformed launch.json — don't touch it
        }
    } else {
        if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
        }
        const launch = {
            version: '0.2.0',
            configurations: [cosmosConfig]
        };
        fs.writeFileSync(launchPath, JSON.stringify(launch, null, 4) + '\n');
    }
}
