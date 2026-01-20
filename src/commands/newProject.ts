import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { isCosmosToolsInstalled } from '../utils/cosmos';
import { execWithPath } from '../utils/execution';
import { getDefaultQemuConfig, updateCosmosProjectContext } from '../utils/project';
import { getBuildChannel } from '../utils/output';
import { ProjectTreeProvider } from '../providers/projectTree';
import { ToolsTreeProvider } from '../providers/toolsTree';

export async function newProjectCommand(context: vscode.ExtensionContext, projectTreeProvider: ProjectTreeProvider, toolsTreeProvider: ToolsTreeProvider) {
    const buildChannel = getBuildChannel();

    // Check if cosmos is installed (cross-platform detection)
    if (!isCosmosToolsInstalled()) {
        const install = await vscode.window.showWarningMessage(
            'Cosmos Tools is required to create projects. Install now?',
            'Install', 'Cancel'
        );
        if (install !== 'Install') return;

        const terminal = vscode.window.createTerminal('Cosmos Setup');
        terminal.show();
        terminal.sendText('dotnet tool install -g Cosmos.Tools && cosmos install');

        await vscode.window.showInformationMessage(
            'Installing Cosmos Tools. Please run "Create Kernel Project" again after installation completes.',
            'OK'
        );
        return;
    }

    // Check if templates are installed
    let templatesInstalled = false;
    try {
        const result = execWithPath('dotnet new list cosmos-kernel', { encoding: 'utf8' });
        templatesInstalled = result.includes('cosmos-kernel');
    } catch { }

    if (!templatesInstalled) {
        const terminal = vscode.window.createTerminal('Cosmos Setup');
        terminal.show();
        terminal.sendText('dotnet new install Cosmos.Build.Templates');

        await vscode.window.showInformationMessage(
            'Installing Cosmos templates. Please run "Create Kernel Project" again after installation completes.',
            'OK'
        );
        return;
    }

    // Ask for project name
    const projectName = await vscode.window.showInputBox({
        prompt: 'Enter the kernel project name',
        placeHolder: 'MyKernel',
        validateInput: (value) => {
            if (!value) return 'Project name is required';
            if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value)) {
                return 'Project name must start with a letter and contain only letters, numbers, and underscores';
            }
            return null;
        }
    });

    if (!projectName) return;

    // Ask for target architecture
    const arch = await vscode.window.showQuickPick(
        [
            { label: 'x64', description: 'Intel/AMD 64-bit (recommended for most users)' },
            { label: 'arm64', description: 'ARM 64-bit (Raspberry Pi, Apple Silicon VMs)' }
        ],
        {
            placeHolder: 'Select target architecture',
            title: 'Target Architecture'
        }
    );

    if (!arch) return;

    // Ask where to create the project
    const location = await vscode.window.showQuickPick(
        [
            { label: 'Current Folder', description: 'Create project files here', value: 'current' },
            { label: 'New Folder', description: 'Create in a new subfolder', value: 'subfolder' },
            { label: 'Choose Location...', description: 'Select a different location', value: 'browse' }
        ],
        {
            placeHolder: 'Where should the project be created?',
            title: 'Project Location'
        }
    );

    if (!location) return;

    let projectPath: string;
    let createInCurrentDir = false;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    if (location.value === 'current' && workspaceFolder) {
        projectPath = workspaceFolder.uri.fsPath;
        createInCurrentDir = true;
    } else if (location.value === 'subfolder' && workspaceFolder) {
        projectPath = path.join(workspaceFolder.uri.fsPath, projectName);
    } else {
        const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Location',
            title: 'Select project location'
        });

        if (!folderUri || folderUri.length === 0) return;
        projectPath = path.join(folderUri[0].fsPath, projectName);
    }

    // Create the project
    buildChannel.show();
    buildChannel.appendLine(`Creating Cosmos kernel project: ${projectName}`);
    buildChannel.appendLine(`Architecture: ${arch.label}`);
    buildChannel.appendLine(`Location: ${projectPath}`);
    buildChannel.appendLine('');

    try {
        // Create directory if needed
        if (!fs.existsSync(projectPath)) {
            fs.mkdirSync(projectPath, { recursive: true });
        }

        // Run dotnet new (use -o . when creating in current dir to avoid subdirectory)
        const outputFlag = createInCurrentDir ? '-o .' : '';
        const cmd = `dotnet new cosmos-kernel -n ${projectName} ${outputFlag} --force`;
        buildChannel.appendLine(`> ${cmd}`);

        const result = execWithPath(cmd, {
            cwd: projectPath,
            encoding: 'utf8'
        });
        buildChannel.appendLine(result);

        // Save selected architecture to .cosmos/config.json
        const cosmosDir = path.join(projectPath, '.cosmos');
        if (!fs.existsSync(cosmosDir)) {
            fs.mkdirSync(cosmosDir, { recursive: true });
        }
        const configPath = path.join(cosmosDir, 'config.json');
        const config = { targetArch: arch.label, qemu: getDefaultQemuConfig(arch.label) };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        buildChannel.appendLine('');
        buildChannel.appendLine('  -hrr-                                       ___');
        buildChannel.appendLine('                                          ,o88888');
        buildChannel.appendLine("                                       ,o8888888'");
        buildChannel.appendLine('                 ,:o:o:oooo.        ,8O88Pd888"');
        buildChannel.appendLine('             ,.::.::o:ooooOoOoO. ,oO8O8Pd888\'');
        buildChannel.appendLine('           ,.:.::o:ooOoOoOO8O8OOo.8OOPd8O8O"');
        buildChannel.appendLine('          , ..:.::o:ooOoOOOO8OOOOo.FdO8O8"');
        buildChannel.appendLine('         , ..:.::o:ooOoOO8O888O8O,COCOO"');
        buildChannel.appendLine('        , . ..:.::o:ooOoOOOO8OOOOCOCO"');
        buildChannel.appendLine('        . ..:.::o:ooOoOoOO8O8OCCCC"o');
        buildChannel.appendLine('           . ..:.::o:ooooOoCoCCC"oo:o');
        buildChannel.appendLine('           . ..:.::o:o:,cooooCo"oo:o:');
        buildChannel.appendLine("         `   . . ..:.:cocoooo\"'o:o:::'");
        buildChannel.appendLine("         .`   . ..::ccccoc\"'o:o:o:::'");
        buildChannel.appendLine("        :.:.    ,c:cccc\"':.:.:.:.:.'");
        buildChannel.appendLine("      ..:.:\"\\'`::::c:\"'..:.:.:.:.:.'");
        buildChannel.appendLine("    ...:.'.:.::::\"'    . . . . .'");
        buildChannel.appendLine("   .. . ....:.\"' `   .  . . ''");
        buildChannel.appendLine(" . . . ....\"'");
        buildChannel.appendLine(" .. . .\"'");
        buildChannel.appendLine('.');
        // Get Cosmos.Kernel version from csproj
        let cosmosVersion = '';
        const csprojPath = path.join(projectPath, `${projectName}.csproj`);
        if (fs.existsSync(csprojPath)) {
            const csprojContent = fs.readFileSync(csprojPath, 'utf8');
            const versionMatch = csprojContent.match(/<PackageReference\s+Include="Cosmos.Kernel"\s+Version="([^"]+)"/);
            if (versionMatch) {
                cosmosVersion = versionMatch[1];
            }
        }
        buildChannel.appendLine('         Cosmos gen3 v' + cosmosVersion);
        buildChannel.appendLine('');
        buildChannel.appendLine(`Project created successfully! (Target: ${arch.label})`);

        // Open the project automatically
        if (createInCurrentDir) {
            // Just refresh the context since we're already in the right folder
            updateCosmosProjectContext();
            projectTreeProvider.refresh();
            toolsTreeProvider.refresh();
            vscode.window.showInformationMessage(`Cosmos kernel "${projectName}" created successfully!`);
        } else {
            // Open the new project folder
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), false);
        }
    } catch (error: any) {
        buildChannel.appendLine(`Error: ${error.message}`);
        if (error.stdout) buildChannel.appendLine(error.stdout);
        if (error.stderr) buildChannel.appendLine(error.stderr);
        vscode.window.showErrorMessage(`Failed to create project: ${error.message}`);
    }
}
