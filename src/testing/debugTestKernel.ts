import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Boots a test kernel under the cosmos-debug adapter (QEMU + gdb-mi). The
 * adapter owns cosmos and tears it down when the session ends, so the
 * Testing view's Stop button reliably kills the QEMU subtree.
 */
export async function debugTestKernel(projectDir: string, arch: string): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return false;
    }

    const csprojFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.csproj'));
    if (csprojFiles.length === 0) {
        vscode.window.showErrorMessage(`No .csproj in ${projectDir}`);
        return false;
    }
    const kernelName = path.basename(csprojFiles[0], '.csproj');

    return vscode.debug.startDebugging(workspaceFolder, {
        name: `Cosmos Test Debug ${kernelName} ${arch}`,
        type: 'cosmos-debug',
        request: 'launch',
        arch,
        projectDir,
        kernelName
    });
}
