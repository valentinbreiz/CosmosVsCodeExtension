import * as vscode from 'vscode';
import { getProjectInfo } from '../utils/project';

export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ProjectItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private _isDebugging = false;

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    setDebugging(debugging: boolean): void {
        this._isDebugging = debugging;
        this.refresh();
    }

    getTreeItem(element: ProjectItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ProjectItem): ProjectItem[] {
        if (element) return [];

        const project = getProjectInfo();
        if (!project) return [];

        const arch = project.arch;
        const archLabel = arch === 'arm64' ? 'ARM64' : 'x64';
        const archDesc = arch === 'arm64' ? 'ARM 64-bit' : 'Intel/AMD 64-bit';

        const items = [
            new ProjectItem('Properties', 'Edit project settings', 'cosmos.projectProperties', undefined, '$(settings-gear)'),
            new ProjectItem(`Build`, `Build for ${archDesc}`, 'cosmos.build', arch, '$(gear)'),
            new ProjectItem(`Run`, `Run in QEMU (${archLabel})`, 'cosmos.run', arch, '$(play)'),
            new ProjectItem(`Debug`, `Debug with GDB (${archLabel})`, 'cosmos.debug', arch, '$(debug-alt)')
        ];

        // Show Memory Regions only when debugging
        if (this._isDebugging) {
            items.push(new ProjectItem('Memory Regions', 'View kernel memory layout', 'cosmos.memoryRegions', undefined, '$(graph)'));
        }

        items.push(new ProjectItem('Clean', 'Remove build outputs', 'cosmos.clean', undefined, '$(trash)'));

        return items;
    }
}

export class ProjectItem extends vscode.TreeItem {
    constructor(
        label: string,
        tooltip: string,
        commandId: string,
        public readonly arch?: string,
        icon?: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = tooltip;
        this.iconPath = icon ? new vscode.ThemeIcon(icon.replace('$(', '').replace(')', '')) : undefined;
        this.command = {
            command: commandId,
            title: label,
            arguments: arch ? [arch] : []
        };
    }
}
