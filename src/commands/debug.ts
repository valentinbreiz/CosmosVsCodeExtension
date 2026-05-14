import * as vscode from 'vscode';
import { getProjectInfo } from '../utils/project';

/**
 * Kicks off a Cosmos kernel debug session. All process supervision (cosmos,
 * QEMU, gdb) lives inside the inline cosmos-debug adapter — this command is
 * just a thin entrypoint that asks VS Code to start that session.
 */
export async function debugCommand(arch?: string): Promise<void> {
    const projectInfo = getProjectInfo();
    if (!projectInfo) {
        vscode.window.showErrorMessage('No Cosmos project found');
        return;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const target = arch || projectInfo.arch;
    const started = await vscode.debug.startDebugging(workspaceFolder, {
        name: `Debug ${target} Kernel`,
        type: 'cosmos-debug',
        request: 'launch',
        arch: target
    });
    if (started) {
        // Swing the sidebar to the built-in Run-and-Debug view so the user
        // lands on Variables/Watch/Call Stack + the Cosmos Kernel Threads
        // view, instead of staying on the Cosmos sidebar.
        await vscode.commands.executeCommand('workbench.view.debug');
    }
}
