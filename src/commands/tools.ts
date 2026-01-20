import * as vscode from 'vscode';
import { execWithPath } from '../utils/execution';
import { getBuildChannel } from '../utils/output';
import { ToolsTreeProvider } from '../providers/toolsTree';

export async function checkToolsCommand(toolsTreeProvider: ToolsTreeProvider) {
    toolsTreeProvider.refresh();
    const buildChannel = getBuildChannel();

    buildChannel.show();
    buildChannel.appendLine('Checking development tools...');
    buildChannel.appendLine('');

    try {
        const result = execWithPath('cosmos check', { encoding: 'utf8' });
        buildChannel.appendLine(result);
    } catch (error: any) {
        if (error.stdout) {
            buildChannel.appendLine(error.stdout);
        }
        vscode.window.showWarningMessage(
            'Some development tools are missing. Run "Install Tools" to install them.',
            'Install Tools'
        ).then(selection => {
            if (selection === 'Install Tools') {
                installToolsCommand();
            }
        });
    }
}

export async function installToolsCommand() {
    const terminal = vscode.window.createTerminal('Cosmos Tools');
    terminal.show();
    terminal.sendText('cosmos install');
}
