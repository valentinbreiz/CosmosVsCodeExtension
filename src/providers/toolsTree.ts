import * as vscode from 'vscode';
import { isCosmosToolsInstalled, getToolsCheck, refreshToolsCheck } from '../utils/cosmos';
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
            this.tools.push(new ToolItem('Cosmos Tools', false, 'Not installed - run: dotnet tool install -g Cosmos.Tools'));
            return;
        }

        // Refresh the shared cache and read from it
        refreshToolsCheck();
        const data = getToolsCheck();

        if (!data) {
            this.tools.push(new ToolItem('Cosmos Tools', false, 'Check failed - reinstall Cosmos.Tools'));
            return;
        }

        // Add cosmos itself as installed, with version from dotnet tool list
        const cosmosVersion = this.getCosmosToolsVersion();
        this.tools.push(new ToolItem('Cosmos Tools', true, cosmosVersion ? `${cosmosVersion}` : 'Installed'));

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
    }

    private getCosmosToolsVersion(): string | null {
        try {
            const output = execWithPath('dotnet tool list -g', { encoding: 'utf8', timeout: 5000 });
            const match = output.split('\n').find(line => line.toLowerCase().startsWith('cosmos.tools'));
            if (match) {
                // Format: "cosmos.tools   3.0.37   cosmos"
                return match.trim().split(/\s+/)[1] ?? null;
            }
        } catch {
            // ignore
        }
        return null;
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
