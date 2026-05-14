import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { isCosmosProject } from '../utils/project';

/**
 * Provides "Cosmos: Debug Kernel" in the Run and Debug dropdown. The actual
 * adapter implementation lives in src/debug/kernelDebugAdapter.ts.
 */
export class CosmosDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(
        _folder: vscode.WorkspaceFolder | undefined,
        _token?: vscode.CancellationToken
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
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration | undefined> {
        // F5 with no launch.json: synthesize a default config.
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
 * Ensures .vscode/launch.json contains the Cosmos debug configuration so the
 * Run and Debug panel surfaces it without the user typing a config.
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
            const raw = fs.readFileSync(launchPath, 'utf8');
            const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
            const launch = JSON.parse(stripped);
            const configs: any[] = launch.configurations || [];
            const hasCosmosDebug = configs.some((c: any) => c.type === 'cosmos-debug');
            if (!hasCosmosDebug) {
                configs.push(cosmosConfig);
                launch.configurations = configs;
                fs.writeFileSync(launchPath, JSON.stringify(launch, null, 4) + '\n');
            }
        } catch {
            // Malformed launch.json — leave it alone
        }
    } else {
        if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
        }
        const launch = { version: '0.2.0', configurations: [cosmosConfig] };
        fs.writeFileSync(launchPath, JSON.stringify(launch, null, 4) + '\n');
    }
}
