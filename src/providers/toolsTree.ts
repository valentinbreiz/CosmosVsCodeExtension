import * as vscode from 'vscode';
import { isCosmosToolsInstalled } from '../utils/cosmos';
import { execWithPath } from '../utils/execution';

export class ToolsTreeProvider implements vscode.TreeDataProvider<ToolItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ToolItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private tools: ToolItem[] = [];

    refresh(): void {
        this.checkTools();
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ToolItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ToolItem): ToolItem[] {
        if (element) return [];

        if (this.tools.length === 0) {
            this.checkTools();
        }
        return this.tools;
    }

    private checkTools() {
        this.tools = [];

        // First check if cosmos is installed
        if (!isCosmosToolsInstalled()) {
            // Fallback to basic checks if cosmos not installed
            this.tools.push(this.checkCommand('dotnet', 'dotnet --version', '.NET SDK'));
            this.tools.push(new ToolItem('Cosmos Tools', false, 'Not installed - run: dotnet tool install -g Cosmos.Tools'));
            return;
        }

        // Use cosmos check --json for cross-platform detection
        try {
            const result = execWithPath('cosmos check --json', { encoding: 'utf8', timeout: 10000 });
            const data = JSON.parse(result);

            // Add cosmos itself as installed
            this.tools.push(new ToolItem('Cosmos Tools', true, 'Installed'));

            // Parse tool results from JSON
            if (data.tools && Array.isArray(data.tools)) {
                for (const tool of data.tools) {
                    this.tools.push(new ToolItem(
                        tool.displayName,
                        tool.found,
                        tool.found ? (tool.version || 'Installed') : 'Not installed'
                    ));
                }
            }
        } catch (e) {
            // If cosmos check fails, fall back to basic checks
            this.tools.push(new ToolItem('Cosmos Tools', true, 'Installed (check failed)'));
            this.tools.push(this.checkCommand('dotnet', 'dotnet --version', '.NET SDK'));
            this.tools.push(this.checkCommand('qemu-system-x86_64', 'qemu-system-x86_64 --version', 'QEMU x64'));
            this.tools.push(this.checkCommand('qemu-system-aarch64', 'qemu-system-aarch64 --version', 'QEMU ARM64'));
            this.tools.push(this.checkCommand('gdb', 'gdb --version', 'GDB Debugger'));
        }
    }

    private checkCommand(name: string, command: string, displayName: string): ToolItem {
        try {
            const output = execWithPath(command, { encoding: 'utf8', timeout: 5000 }).split('\n')[0];
            return new ToolItem(displayName, true, output.trim());
        } catch {
            return new ToolItem(displayName, false, 'Not installed');
        }
    }
}

export class ToolItem extends vscode.TreeItem {
    constructor(label: string, installed: boolean, version: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = version;
        this.iconPath = new vscode.ThemeIcon(
            installed ? 'check' : 'x',
            installed ? new vscode.ThemeColor('testing.iconPassed') : new vscode.ThemeColor('testing.iconFailed')
        );
        this.tooltip = installed ? `${label}: ${version}` : `${label} is not installed`;
    }
}
