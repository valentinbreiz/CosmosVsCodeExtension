import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, spawn, ChildProcess } from 'child_process';

let buildChannel: vscode.OutputChannel;
let outputChannel: vscode.OutputChannel;

// Get PATH with dotnet tools directory included
function getEnvWithDotnetTools(): NodeJS.ProcessEnv {
    const home = os.homedir();
    const dotnetToolsPath = path.join(home, '.dotnet', 'tools');
    const currentPath = process.env.PATH || '';
    const pathSeparator = process.platform === 'win32' ? ';' : ':';

    return {
        ...process.env,
        PATH: `${dotnetToolsPath}${pathSeparator}${currentPath}`
    };
}

function execWithPath(command: string, options: { encoding: 'utf8'; timeout?: number; cwd?: string } = { encoding: 'utf8' }): string {
    try {
        // Use platform-appropriate shell
        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
        return execSync(command, {
            ...options,
            env: getEnvWithDotnetTools(),
            shell: shell
        });
    } catch (e) {
        throw e;
    }
}

// Cross-platform cosmos executable detection
function getCosmosToolsPath(): string | null {
    const home = os.homedir();
    const toolsDir = path.join(home, '.dotnet', 'tools');

    // Check for different executable names based on platform
    const executableNames = process.platform === 'win32'
        ? ['cosmos.exe', 'cosmos']
        : ['cosmos'];

    for (const name of executableNames) {
        const fullPath = path.join(toolsDir, name);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }
    return null;
}

function isCosmosToolsInstalled(): boolean {
    return getCosmosToolsPath() !== null;
}

// Platform info from cosmos
interface PlatformInfo {
    platform: string;
    platformName: string;
    arch: string;
    packageManager: string;
    qemuDisplay: string;
    gdbCommand: string;
    arm64UefiBios: string | null;
    cosmosToolsPath: string | null;
}

let cachedPlatformInfo: PlatformInfo | null = null;

function getPlatformInfo(): PlatformInfo {
    if (cachedPlatformInfo) {
        return cachedPlatformInfo;
    }

    // Try to get from cosmos
    if (isCosmosToolsInstalled()) {
        try {
            const result = execWithPath('cosmos info --json', { encoding: 'utf8', timeout: 5000 });
            cachedPlatformInfo = JSON.parse(result);
            return cachedPlatformInfo!;
        } catch {
            // Fall through to defaults
        }
    }

    // Fallback defaults based on Node.js process.platform
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    cachedPlatformInfo = {
        platform: isWindows ? 'windows' : isMac ? 'macos' : 'linux',
        platformName: isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux',
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        packageManager: isWindows ? 'choco' : isMac ? 'brew' : 'apt',
        qemuDisplay: isWindows ? 'sdl' : isMac ? 'cocoa' : 'gtk',
        gdbCommand: 'gdb',
        arm64UefiBios: null,
        cosmosToolsPath: null
    };

    return cachedPlatformInfo;
}

let projectTreeProvider: ProjectTreeProvider;
let toolsTreeProvider: ToolsTreeProvider;

export function activate(context: vscode.ExtensionContext) {
    buildChannel = vscode.window.createOutputChannel('Cosmos OS - Build');
    outputChannel = vscode.window.createOutputChannel('Cosmos OS - Output');

    // Initialize tree providers
    projectTreeProvider = new ProjectTreeProvider();
    toolsTreeProvider = new ToolsTreeProvider();

    // Register tree views
    vscode.window.registerTreeDataProvider('cosmos.project', projectTreeProvider);
    vscode.window.registerTreeDataProvider('cosmos.tools', toolsTreeProvider);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('cosmos.newProject', () => newProjectCommand(context)),
        vscode.commands.registerCommand('cosmos.checkTools', checkToolsCommand),
        vscode.commands.registerCommand('cosmos.installTools', installToolsCommand),
        vscode.commands.registerCommand('cosmos.build', buildCommand),
        vscode.commands.registerCommand('cosmos.run', runCommand),
        vscode.commands.registerCommand('cosmos.debug', debugCommand),
        vscode.commands.registerCommand('cosmos.clean', cleanCommand),
        vscode.commands.registerCommand('cosmos.refreshTools', () => toolsTreeProvider.refresh()),
        vscode.commands.registerCommand('cosmos.projectProperties', () => showProjectProperties(context))
    );

    // Check if this is a Cosmos project and update context
    updateCosmosProjectContext();

    // Watch for workspace changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            updateCosmosProjectContext();
            projectTreeProvider.refresh();
            toolsTreeProvider.refresh();
        })
    );
}

export function deactivate() { }

function findCsprojFiles(dir: string, depth: number = 0): string[] {
    if (depth > 3) return []; // Limit search depth
    const results: string[] = [];

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.endsWith('.csproj')) {
                results.push(fullPath);
            } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'bin' && entry.name !== 'obj') {
                results.push(...findCsprojFiles(fullPath, depth + 1));
            }
        }
    } catch { }

    return results;
}

function isCosmosProject(): boolean {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return false;

    for (const folder of workspaceFolders) {
        const csprojFiles = findCsprojFiles(folder.uri.fsPath);

        for (const csproj of csprojFiles) {
            try {
                const content = fs.readFileSync(csproj, 'utf8');
                if (content.includes('Cosmos.Sdk') || content.includes('Cosmos.Kernel')) {
                    return true;
                }
            } catch { }
        }
    }
    return false;
}

function updateCosmosProjectContext() {
    const isCosmos = isCosmosProject();
    vscode.commands.executeCommand('setContext', 'cosmos:isCosmosProject', isCosmos);
}

function getProjectInfo(): { name: string; arch: string; csproj: string } | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return null;

    for (const folder of workspaceFolders) {
        const csprojFiles = findCsprojFiles(folder.uri.fsPath);

        for (const csproj of csprojFiles) {
            try {
                const content = fs.readFileSync(csproj, 'utf8');
                if (content.includes('Cosmos.Sdk') || content.includes('Cosmos.Kernel')) {
                    const projectDir = path.dirname(csproj);

                    // Read architecture from .cosmos/config.json
                    let arch = 'x64';
                    const configPath = path.join(projectDir, '.cosmos', 'config.json');
                    if (fs.existsSync(configPath)) {
                        try {
                            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                            if (config.targetArch) {
                                arch = config.targetArch;
                            }
                        } catch { }
                    }

                    return {
                        name: path.basename(csproj, '.csproj'),
                        arch: arch,
                        csproj: csproj
                    };
                }
            } catch { }
        }
    }
    return null;
}

// ============================================================================
// Tree Providers
// ============================================================================

class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ProjectItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
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

        return [
            new ProjectItem('Properties', 'Edit project settings', 'cosmos.projectProperties', undefined, '$(settings-gear)'),
            new ProjectItem(`Build`, `Build for ${archDesc}`, 'cosmos.build', arch, '$(gear)'),
            new ProjectItem(`Run`, `Run in QEMU (${archLabel})`, 'cosmos.run', arch, '$(play)'),
            new ProjectItem(`Debug`, `Debug with GDB (${archLabel})`, 'cosmos.debug', arch, '$(debug-alt)'),
            new ProjectItem('Clean', 'Remove build outputs', 'cosmos.clean', undefined, '$(trash)')
        ];
    }
}

class ProjectItem extends vscode.TreeItem {
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

class ToolsTreeProvider implements vscode.TreeDataProvider<ToolItem> {
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

class ToolItem extends vscode.TreeItem {
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

// ============================================================================
// Commands
// ============================================================================

async function newProjectCommand(context: vscode.ExtensionContext) {
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
        buildChannel.appendLine('                 ,:o:o:oooo.        ,8O88Pd8888"');
        buildChannel.appendLine('             ,.::.::o:ooooOoOoO. ,oO8O8Pd888\'"');
        buildChannel.appendLine('           ,.:.::o:ooOoOoOO8O8OOo.8OOPd8O8O"');
        buildChannel.appendLine('          , ..:.::o:ooOoOOOO8OOOOo.FdO8O8"');
        buildChannel.appendLine('         , ..:.::o:ooOoOO8O888O8O,COCOO"');
        buildChannel.appendLine('        , . ..:.::o:ooOoOOOO8OOOOCOCO"');
        buildChannel.appendLine('         . ..:.::o:ooOoOoOO8O8OCCCC"o');
        buildChannel.appendLine('            . ..:.::o:ooooOoCoCCC"o:o');
        buildChannel.appendLine('            . ..:.::o:o:,cooooCo"oo:o:');
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
            const versionMatch = csprojContent.match(/<PackageReference\s+Include="Cosmos\.Kernel"\s+Version="([^"]+)"/);
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

async function checkToolsCommand() {
    toolsTreeProvider.refresh();

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

async function installToolsCommand() {
    const terminal = vscode.window.createTerminal('Cosmos Tools');
    terminal.show();
    terminal.sendText('cosmos install');
}

async function buildCommand(arch?: string) {
    // Get project info first to use configured architecture as default
    const projectInfo = getProjectInfo();
    if (!projectInfo) {
        vscode.window.showErrorMessage('No Cosmos project found');
        return;
    }

    if (!arch) {
        // Use project's configured architecture as default
        arch = projectInfo.arch;
    }

    const config = await vscode.window.showQuickPick(
        [
            { label: 'Debug', description: 'Debug build with symbols' },
            { label: 'Release', description: 'Optimized release build' }
        ],
        { placeHolder: 'Select build configuration' }
    );

    if (!config) return;

    const projectDir = path.dirname(projectInfo.csproj);

    // Show output in the build channel
    buildChannel.show(true);
    buildChannel.clear();
    buildChannel.appendLine(`Building ${projectInfo.name} for ${arch} (${config.label})...`);
    buildChannel.appendLine('');

    // Use cosmos build for cross-platform support
    const buildArgs = [
        'build',
        '-p', projectDir,
        '-a', arch,
        '-c', config.label,
        '-v'  // Verbose for output channel
    ];

    buildChannel.appendLine(`> cosmos ${buildArgs.join(' ')}`);
    buildChannel.appendLine('');

    const buildProcess = spawn('cosmos', buildArgs, {
        cwd: projectDir,
        env: getEnvWithDotnetTools(),
        shell: true
    });

    // Strip ANSI escape codes for clean output in VS Code
    const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');

    buildProcess.stdout?.on('data', (data: Buffer) => {
        buildChannel.append(stripAnsi(data.toString()));
    });

    buildProcess.stderr?.on('data', (data: Buffer) => {
        buildChannel.append(stripAnsi(data.toString()));
    });

    buildProcess.on('close', (code) => {
        buildChannel.appendLine('');
        if (code === 0) {
            buildChannel.appendLine('Build completed successfully.');
            vscode.window.showInformationMessage(`Build completed: ${projectInfo.name} (${arch})`);
        } else {
            buildChannel.appendLine(`Build failed with exit code ${code}`);
            vscode.window.showErrorMessage(`Build failed with exit code ${code}`);
        }
    });

    buildProcess.on('error', (err) => {
        buildChannel.appendLine(`Error: ${err.message}`);
        vscode.window.showErrorMessage(`Build error: ${err.message}`);
    });
}

async function runCommand(arch?: string) {
    const projectInfo = getProjectInfo();
    if (!projectInfo) {
        vscode.window.showErrorMessage('No Cosmos project found');
        return;
    }

    if (!arch) {
        // Use project's configured architecture as default
        arch = projectInfo.arch;
    }

    const projectDir = path.dirname(projectInfo.csproj);
    const outputDir = path.join(projectDir, `output-${arch}`);

    if (!fs.existsSync(outputDir)) {
        const build = await vscode.window.showWarningMessage(
            `No build found for ${arch}. Build first?`,
            'Build', 'Cancel'
        );
        if (build === 'Build') {
            await buildCommand(arch);
        }
        return;
    }

    const isoFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.iso'));
    if (isoFiles.length === 0) {
        vscode.window.showErrorMessage('No ISO file found. Please build the project first.');
        return;
    }

    const isoPath = path.join(outputDir, isoFiles[0]);
    const qemuConfig = loadQemuConfig(projectDir, arch);
    const platformInfo = getPlatformInfo();

    let qemuCmd: string;
    let qemuArgs: string[];

    if (arch === 'x64') {
        qemuCmd = 'qemu-system-x86_64';
        qemuArgs = [
            '-M', qemuConfig.machineType,
            '-cpu', qemuConfig.cpuModel,
            '-m', qemuConfig.memory,
            '-cdrom', isoPath,
            '-display', platformInfo.qemuDisplay,
            '-vga', 'std',
            '-no-reboot', '-no-shutdown'
        ];

        if (qemuConfig.serialMode === 'stdio') {
            qemuArgs.push('-serial', 'stdio');
        }

        if (qemuConfig.enableNetwork) {
            const ports = qemuConfig.networkPorts.split(',').map(p => p.trim()).filter(p => p);
            const portForwards = ports.map(p => `hostfwd=udp::${p}-:${p}`).join(',');
            qemuArgs.push('-netdev', `user,id=net0${portForwards ? ',' + portForwards : ''}`);
            qemuArgs.push('-device', 'e1000,netdev=net0');
        } else {
            qemuArgs.push('-nic', 'none');
        }
    } else {
        qemuCmd = 'qemu-system-aarch64';
        qemuArgs = [
            '-M', qemuConfig.machineType,
            '-cpu', qemuConfig.cpuModel,
            '-m', qemuConfig.memory
        ];

        // Use platform-detected UEFI BIOS path
        const biosPath = platformInfo.arm64UefiBios;
        if (biosPath) {
            qemuArgs.push('-bios', biosPath);
        } else {
            vscode.window.showWarningMessage('ARM64 UEFI BIOS not found. QEMU may fail to boot.');
        }

        qemuArgs.push(
            '-drive', `if=none,id=cd,file=${isoPath}`,
            '-device', 'virtio-scsi-pci',
            '-device', 'scsi-cd,drive=cd,bootindex=0',
            '-device', 'virtio-keyboard-device',
            '-device', 'ramfb',
            '-display', `${platformInfo.qemuDisplay},show-cursor=on`,
            '-nic', 'none'
        );

        if (qemuConfig.serialMode === 'stdio') {
            qemuArgs.push('-serial', 'stdio');
        }
    }

    // Add extra arguments if specified
    if (qemuConfig.extraArgs) {
        qemuArgs.push(...qemuConfig.extraArgs.split(' ').filter(a => a));
    }

    // Show output in the output channel
    outputChannel.show(true);
    outputChannel.clear();
    outputChannel.appendLine(`Running ${projectInfo.name} (${arch}) in QEMU...`);
    outputChannel.appendLine(`Platform: ${platformInfo.platformName}`);
    outputChannel.appendLine('');
    outputChannel.appendLine(`> ${qemuCmd} ${qemuArgs.join(' ')}`);
    outputChannel.appendLine('');

    const qemuProcess = spawn(qemuCmd, qemuArgs, {
        cwd: projectDir,
        env: getEnvWithDotnetTools(),
        shell: true
    });

    qemuProcess.stdout?.on('data', (data: Buffer) => {
        outputChannel.append(data.toString());
    });

    qemuProcess.stderr?.on('data', (data: Buffer) => {
        outputChannel.append(data.toString());
    });

    qemuProcess.on('close', (code) => {
        outputChannel.appendLine('');
        outputChannel.appendLine(`QEMU exited with code ${code}`);
    });

    qemuProcess.on('error', (err) => {
        outputChannel.appendLine(`Error: ${err.message}`);
        vscode.window.showErrorMessage(`QEMU error: ${err.message}`);
    });
}

async function debugCommand(arch?: string) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const projectInfo = getProjectInfo();
    if (!projectInfo) {
        vscode.window.showErrorMessage('No Cosmos project found');
        return;
    }

    if (!arch) {
        // Use project's configured architecture as default
        arch = projectInfo.arch;
    }

    const projectDir = path.dirname(projectInfo.csproj);
    const outputDir = path.join(projectDir, `output-${arch}`);
    const binDir = path.join(projectDir, 'bin', 'Debug', 'net10.0', `linux-${arch}`);

    // Check if build exists (ISO in output dir)
    if (!fs.existsSync(outputDir)) {
        const build = await vscode.window.showWarningMessage(
            `No build found for ${arch}. Build first?`,
            'Build', 'Cancel'
        );
        if (build === 'Build') {
            await buildCommand(arch);
        }
        return;
    }

    // Find ISO in output dir
    const outputFiles = fs.readdirSync(outputDir);
    const isoFiles = outputFiles.filter(f => f.endsWith('.iso'));

    // Find ELF in bin dir
    let elfPath: string | null = null;
    if (fs.existsSync(binDir)) {
        const binFiles = fs.readdirSync(binDir);
        const elfFiles = binFiles.filter(f => f.endsWith('.elf'));
        if (elfFiles.length > 0) {
            elfPath = path.join(binDir, elfFiles[0]);
        }
    }

    if (isoFiles.length === 0) {
        const build = await vscode.window.showWarningMessage(
            `Build incomplete for ${arch} (missing ISO). Rebuild?`,
            'Build', 'Cancel'
        );
        if (build === 'Build') {
            await buildCommand(arch);
        }
        return;
    }

    if (!elfPath) {
        const build = await vscode.window.showWarningMessage(
            `Build incomplete for ${arch} (missing ELF for debugging). Rebuild?`,
            'Build', 'Cancel'
        );
        if (build === 'Build') {
            await buildCommand(arch);
        }
        return;
    }

    const isoPath = path.join(outputDir, isoFiles[0]);
    const gdbPort = 1234;
    const qemuConfig = loadQemuConfig(projectDir, arch);
    const platformInfo = getPlatformInfo();

    // Start QEMU with GDB server
    // -s: Start GDB server on port 1234
    // -S: Freeze CPU at startup (wait for GDB to connect)
    let qemuCmd: string;
    let qemuArgs: string[];

    if (arch === 'x64') {
        qemuCmd = 'qemu-system-x86_64';
        qemuArgs = [
            '-M', qemuConfig.machineType,
            '-cpu', qemuConfig.cpuModel,
            '-m', qemuConfig.memory,
            '-cdrom', isoPath,
            '-display', platformInfo.qemuDisplay,
            '-vga', 'std',
            '-no-reboot', '-no-shutdown',
            '-s', '-S'  // GDB server on port 1234, freeze CPU at startup
        ];

        if (qemuConfig.serialMode === 'stdio') {
            qemuArgs.push('-serial', 'stdio');
        }

        if (qemuConfig.enableNetwork) {
            const ports = qemuConfig.networkPorts.split(',').map(p => p.trim()).filter(p => p);
            const portForwards = ports.map(p => `hostfwd=udp::${p}-:${p}`).join(',');
            qemuArgs.push('-netdev', `user,id=net0${portForwards ? ',' + portForwards : ''}`);
            qemuArgs.push('-device', 'e1000,netdev=net0');
        } else {
            qemuArgs.push('-nic', 'none');
        }
    } else {
        qemuCmd = 'qemu-system-aarch64';
        qemuArgs = [
            '-M', qemuConfig.machineType,
            '-cpu', qemuConfig.cpuModel,
            '-m', qemuConfig.memory
        ];

        // Use platform-detected UEFI BIOS path
        const biosPath = platformInfo.arm64UefiBios;
        if (biosPath) {
            qemuArgs.push('-bios', biosPath);
        } else {
            vscode.window.showWarningMessage('ARM64 UEFI BIOS not found. QEMU may fail to boot.');
        }

        qemuArgs.push(
            '-drive', `if=none,id=cd,file=${isoPath}`,
            '-device', 'virtio-scsi-pci',
            '-device', 'scsi-cd,drive=cd,bootindex=0',
            '-device', 'virtio-keyboard-device',
            '-device', 'ramfb',
            '-display', `${platformInfo.qemuDisplay},show-cursor=on`,
            '-nic', 'none',
            '-s', '-S'  // GDB server on port 1234, freeze CPU at startup
        );

        if (qemuConfig.serialMode === 'stdio') {
            qemuArgs.push('-serial', 'stdio');
        }
    }

    // Add extra arguments if specified
    if (qemuConfig.extraArgs) {
        qemuArgs.push(...qemuConfig.extraArgs.split(' ').filter(a => a));
    }

    // Show output in the output channel
    outputChannel.show(true);
    outputChannel.clear();
    outputChannel.appendLine(`Debugging ${projectInfo.name} (${arch}) with GDB`);
    outputChannel.appendLine(`GDB server port: ${gdbPort}`);
    outputChannel.appendLine(`ELF: ${elfPath}`);
    outputChannel.appendLine('');
    outputChannel.appendLine(`> ${qemuCmd} ${qemuArgs.join(' ')}`);
    outputChannel.appendLine('');

    const qemuProcess = spawn(qemuCmd, qemuArgs, {
        cwd: projectDir,
        env: getEnvWithDotnetTools(),
        shell: true
    });

    qemuProcess.stdout?.on('data', (data: Buffer) => {
        outputChannel.append(data.toString());
    });

    qemuProcess.stderr?.on('data', (data: Buffer) => {
        outputChannel.append(data.toString());
    });

    qemuProcess.on('close', (code) => {
        outputChannel.appendLine('');
        outputChannel.appendLine(`QEMU exited with code ${code}`);
    });

    qemuProcess.on('error', (err) => {
        outputChannel.appendLine(`Error: ${err.message}`);
        vscode.window.showErrorMessage(`QEMU error: ${err.message}`);
    });

    // Wait for QEMU to start
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Create GDB debug configuration using cppdbg
    // Use platform-detected GDB command
    const gdbPath = platformInfo.gdbCommand;
    const debugConfig: vscode.DebugConfiguration = {
        name: `Debug ${arch} Kernel`,
        type: 'cppdbg',
        request: 'launch',
        program: elfPath,
        cwd: projectDir,
        MIMode: 'gdb',
        miDebuggerPath: gdbPath,
        miDebuggerServerAddress: `localhost:${gdbPort}`,
        stopAtEntry: false,
        setupCommands: [
            {
                description: 'Enable pretty-printing for gdb',
                text: '-enable-pretty-printing',
                ignoreFailures: true
            },
            {
                description: 'Set disassembly flavor to Intel',
                text: '-gdb-set disassembly-flavor intel',
                ignoreFailures: true
            }
        ],
        // Show registers in Variables panel
        showDisplayString: true
    };

    // Start debugging with GDB
    vscode.debug.startDebugging(workspaceFolder, debugConfig);
}

async function cleanCommand() {
    const projectInfo = getProjectInfo();
    if (!projectInfo) {
        vscode.window.showErrorMessage('No Cosmos project found');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        'Delete all build outputs?',
        'Yes', 'No'
    );

    if (confirm !== 'Yes') return;

    const projectDir = path.dirname(projectInfo.csproj);
    const dirsToClean = ['output-x64', 'output-arm64', 'bin', 'obj'];
    let cleaned = 0;

    for (const dir of dirsToClean) {
        const dirPath = path.join(projectDir, dir);
        if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            cleaned++;
        }
    }

    vscode.window.showInformationMessage(`Cleaned ${cleaned} directories`);
}

// ============================================================================
// Project Properties Panel
// ============================================================================

interface QemuConfig {
    memory: string;
    machineType: string;
    cpuModel: string;
    enableNetwork: boolean;
    networkPorts: string;
    serialMode: string;
    extraArgs: string;
}

interface ProjectProperties {
    name: string;
    targetFramework: string;
    targetArch: string;
    kernelClass: string;
    enableGraphics: boolean;
    gccFlags: string;
    defaultFont: string;
    packages: { name: string; version: string }[];
    qemu: QemuConfig;
}

function getDefaultQemuConfig(arch: string): QemuConfig {
    return {
        memory: '512M',
        machineType: arch === 'arm64' ? 'virt' : 'q35',
        cpuModel: arch === 'arm64' ? 'cortex-a72' : 'max',
        enableNetwork: false,
        networkPorts: '5555',
        serialMode: 'stdio',
        extraArgs: ''
    };
}

function loadQemuConfig(projectDir: string, arch: string): QemuConfig {
    const configPath = path.join(projectDir, '.cosmos', 'config.json');
    const defaults = getDefaultQemuConfig(arch);

    // Machine types valid for each architecture
    const x64MachineTypes = ['q35', 'pc'];
    const arm64MachineTypes = ['virt'];

    // CPU models valid for each architecture
    const x64CpuModels = ['max', 'qemu64', 'host'];
    const arm64CpuModels = ['cortex-a72', 'cortex-a53', 'max'];

    try {
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(content);
            const merged = { ...defaults, ...config.qemu };

            // Validate machine type matches architecture
            if (arch === 'arm64') {
                if (!arm64MachineTypes.includes(merged.machineType)) {
                    merged.machineType = defaults.machineType;
                }
                if (!arm64CpuModels.includes(merged.cpuModel)) {
                    merged.cpuModel = defaults.cpuModel;
                }
            } else {
                if (!x64MachineTypes.includes(merged.machineType)) {
                    merged.machineType = defaults.machineType;
                }
                if (!x64CpuModels.includes(merged.cpuModel)) {
                    merged.cpuModel = defaults.cpuModel;
                }
            }

            return merged;
        }
    } catch { }

    return defaults;
}

function saveQemuConfig(projectDir: string, qemu: QemuConfig): void {
    const cosmosDir = path.join(projectDir, '.cosmos');
    const configPath = path.join(cosmosDir, 'config.json');

    if (!fs.existsSync(cosmosDir)) {
        fs.mkdirSync(cosmosDir, { recursive: true });
    }

    let config: any = {};
    try {
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch { }

    config.qemu = qemu;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function parseProjectProperties(csprojPath: string): ProjectProperties {
    const content = fs.readFileSync(csprojPath, 'utf8');
    const name = path.basename(csprojPath, '.csproj');
    const projectDir = path.dirname(csprojPath);

    // Parse properties using regex
    const getProperty = (prop: string): string => {
        const match = content.match(new RegExp(`<${prop}>([^<]*)</${prop}>`));
        return match ? match[1] : '';
    };

    // Check for package references
    const hasPackage = (pkg: string): boolean => {
        return content.includes(`Include="${pkg}"`);
    };

    // Get all package references
    const packageMatches = content.matchAll(/<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g);
    const packages: { name: string; version: string }[] = [];
    for (const match of packageMatches) {
        if (!match[1].startsWith('Cosmos.Build.') && !match[1].startsWith('Cosmos.Kernel.Native')) {
            packages.push({ name: match[1], version: match[2] });
        }
    }

    // Read architecture from .cosmos/config.json
    let targetArch = 'x64';
    const configPath = path.join(projectDir, '.cosmos', 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.targetArch) {
                targetArch = config.targetArch;
            }
        } catch { }
    }

    return {
        name,
        targetFramework: getProperty('TargetFramework') || 'net10.0',
        targetArch,
        kernelClass: getProperty('CosmosKernelClass') || `${name}.Kernel`,
        enableGraphics: hasPackage('Cosmos.Kernel.Graphics'),
        gccFlags: getProperty('GCCCompilerFlags') || '',
        defaultFont: getProperty('CosmosDefaultFont') || '',
        packages,
        qemu: loadQemuConfig(projectDir, targetArch)
    };
}

function saveProjectProperties(csprojPath: string, props: ProjectProperties): void {
    let content = fs.readFileSync(csprojPath, 'utf8');

    // Helper to set or add property
    const setProperty = (prop: string, value: string) => {
        const regex = new RegExp(`<${prop}>[^<]*</${prop}>`);
        if (regex.test(content)) {
            content = content.replace(regex, `<${prop}>${value}</${prop}>`);
        } else {
            // Add to first PropertyGroup (handle both <PropertyGroup> and <PropertyGroup ...>)
            const pgMatch = content.match(/<PropertyGroup[^>]*>/);
            if (pgMatch) {
                content = content.replace(
                    pgMatch[0],
                    `${pgMatch[0]}\n    <${prop}>${value}</${prop}>`
                );
            }
        }
    };

    // Helper to remove property if empty
    const removeProperty = (prop: string) => {
        content = content.replace(new RegExp(`\\s*<${prop}>[^<]*</${prop}>`, 'g'), '');
    };

    // Update properties (always update, even if empty to remove them)
    setProperty('TargetFramework', props.targetFramework || 'net10.0');

    // Save targetArch to .cosmos/config.json
    const projectDir = path.dirname(csprojPath);
    const cosmosDir = path.join(projectDir, '.cosmos');
    if (!fs.existsSync(cosmosDir)) {
        fs.mkdirSync(cosmosDir, { recursive: true });
    }
    const configPath = path.join(cosmosDir, 'config.json');
    let config: any = {};
    try {
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch { }
    config.targetArch = props.targetArch || 'x64';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    if (props.kernelClass) {
        setProperty('CosmosKernelClass', props.kernelClass);
    }

    if (props.gccFlags) {
        setProperty('GCCCompilerFlags', props.gccFlags);
    } else {
        removeProperty('GCCCompilerFlags');
    }

    if (props.defaultFont) {
        setProperty('CosmosDefaultFont', props.defaultFont);
    } else {
        removeProperty('CosmosDefaultFont');
    }

    // Handle graphics package
    const graphicsRef = '<PackageReference Include="Cosmos.Kernel.Graphics"';
    if (props.enableGraphics && !content.includes(graphicsRef)) {
        // Add graphics package
        const insertPoint = content.indexOf('<PackageReference Include="Cosmos.Kernel.System"');
        if (insertPoint !== -1) {
            const lineEnd = content.indexOf('/>', insertPoint) + 2;
            const version = content.match(/Include="Cosmos\.Kernel\.System"\s+Version="([^"]+)"/)?.[1] || '3.0.7';
            content = content.slice(0, lineEnd) +
                `\n    <PackageReference Include="Cosmos.Kernel.Graphics" Version="${version}" />` +
                content.slice(lineEnd);
        }
    } else if (!props.enableGraphics && content.includes(graphicsRef)) {
        // Remove graphics package
        content = content.replace(/\s*<PackageReference Include="Cosmos\.Kernel\.Graphics"[^/]*\/>/g, '');
    }

    fs.writeFileSync(csprojPath, content);
}

function showProjectProperties(context: vscode.ExtensionContext) {
    const projectInfo = getProjectInfo();
    if (!projectInfo) {
        vscode.window.showErrorMessage('No Cosmos project found');
        return;
    }

    const props = parseProjectProperties(projectInfo.csproj);

    const panel = vscode.window.createWebviewPanel(
        'cosmosProperties',
        `${props.name} - Properties`,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getPropertiesWebviewContent(props, projectInfo.csproj);

    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'save':
                    try {
                        saveProjectProperties(projectInfo.csproj, message.properties);
                        vscode.window.showInformationMessage('Project properties saved successfully');
                        projectTreeProvider.refresh();
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`Failed to save: ${error.message}`);
                    }
                    break;
                case 'saveQemu':
                    try {
                        const projectDir = path.dirname(projectInfo.csproj);
                        saveQemuConfig(projectDir, message.qemu);
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`Failed to save QEMU config: ${error.message}`);
                    }
                    break;
                case 'openCsproj':
                    vscode.workspace.openTextDocument(projectInfo.csproj).then(doc => {
                        vscode.window.showTextDocument(doc);
                    });
                    break;
            }
        },
        undefined,
        context.subscriptions
    );
}

function getPropertiesWebviewContent(props: ProjectProperties, csprojPath: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Project Properties</title>
    <style>
        * {
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            padding: 0;
            margin: 0;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            line-height: 1.5;
        }
        .container {
            padding: 32px 24px;
        }
        .header {
            margin-bottom: 32px;
        }
        .header-top {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }
        .header-actions {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .header h1 {
            font-size: 28px;
            font-weight: 600;
            margin: 0 0 4px 0;
            letter-spacing: -0.5px;
        }
        .header .subtitle {
            color: var(--vscode-descriptionForeground);
            font-size: 14px;
        }
        .section {
            margin-bottom: 32px;
        }
        .section-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 16px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            user-select: none;
        }
        .section-title:hover {
            color: var(--vscode-foreground);
        }
        .section-title .chevron {
            transition: transform 0.2s;
            font-size: 10px;
        }
        .section.collapsed .section-title .chevron {
            transform: rotate(-90deg);
        }
        .section-content {
            overflow: hidden;
            transition: max-height 0.3s ease, opacity 0.2s ease;
            max-height: 1000px;
            opacity: 1;
        }
        .section.collapsed .section-content {
            max-height: 0;
            opacity: 0;
            margin-bottom: -16px;
        }
        .field {
            margin-bottom: 20px;
        }
        .field:last-child {
            margin-bottom: 0;
        }
        .field-label {
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 6px;
            display: block;
        }
        .field-input {
            width: 100%;
            padding: 10px 12px;
            font-size: 14px;
            border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 6px;
            transition: border-color 0.15s, box-shadow 0.15s;
        }
        .field-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 3px rgba(var(--vscode-focusBorder), 0.1);
        }
        .field-input[readonly] {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .field-hint {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 6px;
        }
        .toggle-field {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.1));
        }
        .toggle-field:last-child {
            border-bottom: none;
        }
        .toggle-info {
            flex: 1;
        }
        .toggle-label {
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 2px;
        }
        .toggle-hint {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .toggle-switch {
            position: relative;
            width: 44px;
            height: 24px;
            margin-left: 16px;
        }
        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--vscode-input-border, #555);
            transition: 0.2s;
            border-radius: 24px;
        }
        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 18px;
            width: 18px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            transition: 0.2s;
            border-radius: 50%;
        }
        input:checked + .toggle-slider {
            background-color: var(--vscode-button-background, #0e639c);
        }
        input:checked + .toggle-slider:before {
            transform: translateX(20px);
        }
        .packages {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .package {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
            border-radius: 6px;
        }
        .package-name {
            font-size: 13px;
            font-weight: 500;
        }
        .package-version {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-badge-background, rgba(128,128,128,0.2));
            padding: 2px 8px;
            border-radius: 10px;
        }
        .empty-packages {
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
            font-style: italic;
        }
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 10px 16px;
            font-size: 13px;
            font-weight: 500;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            transition: background-color 0.15s;
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .save-status {
            font-size: 13px;
            color: #3fb950;
            opacity: 0;
            transition: opacity 0.2s;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-top">
                <div>
                    <h1>${props.name}</h1>
                    <div class="subtitle">Cosmos Kernel Project</div>
                </div>
                <div class="header-actions">
                    <span id="saveStatus" class="save-status">Saved</span>
                    <button class="btn btn-secondary" onclick="openCsproj()">Edit .csproj</button>
                </div>
            </div>
        </div>

        <div class="section" id="section-general">
            <div class="section-title" onclick="toggleSection('section-general')"><span>General</span><span class="chevron">▼</span></div>
            <div class="section-content">
            <div class="field">
                <label class="field-label">.NET Version</label>
                <select id="targetFramework" class="field-input">
                    <option value="net10.0" ${props.targetFramework === 'net10.0' ? 'selected' : ''}>.NET 10</option>
                </select>
            </div>

            <div class="field">
                <label class="field-label">Target Architecture</label>
                <select id="targetArch" class="field-input">
                    <option value="x64" ${props.targetArch === 'x64' ? 'selected' : ''}>x64 (Intel/AMD 64-bit)</option>
                    <option value="arm64" ${props.targetArch === 'arm64' ? 'selected' : ''}>ARM64</option>
                </select>
            </div>

            <div class="field">
                <label class="field-label">Kernel Entry Class</label>
                <input type="text" id="kernelClass" class="field-input" value="${props.kernelClass}">
                <div class="field-hint">Fully qualified class name (e.g., MyKernel.Kernel)</div>
            </div>
            </div>
        </div>

        <div class="section" id="section-features">
            <div class="section-title" onclick="toggleSection('section-features')"><span>Features</span><span class="chevron">▼</span></div>
            <div class="section-content">
            <div class="toggle-field">
                <div class="toggle-info">
                    <div class="toggle-label">Graphics Support</div>
                    <div class="toggle-hint">Framebuffer and font rendering</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableGraphics" ${props.enableGraphics ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="field" style="margin-top: 16px;">
                <label class="field-label">Default Font</label>
                <input type="text" id="defaultFont" class="field-input" value="${props.defaultFont}" placeholder="Cosmos.Kernel.Graphics.Fonts.DefaultFont.psf">
            </div>
            </div>
        </div>

        <div class="section collapsed" id="section-advanced">
            <div class="section-title" onclick="toggleSection('section-advanced')"><span>Advanced</span><span class="chevron">▼</span></div>
            <div class="section-content">
            <div class="field">
                <label class="field-label">GCC Compiler Flags</label>
                <input type="text" id="gccFlags" class="field-input" value="${props.gccFlags}" placeholder="Uses SDK defaults if empty">
            </div>
            </div>
        </div>

        <div class="section" id="section-qemu">
            <div class="section-title" onclick="toggleSection('section-qemu')"><span>QEMU Configuration</span><span class="chevron">▼</span></div>
            <div class="section-content">

            <div class="field">
                <label class="field-label">Memory</label>
                <select id="qemuMemory" class="field-input">
                    <option value="256M" ${props.qemu.memory === '256M' ? 'selected' : ''}>256 MB</option>
                    <option value="512M" ${props.qemu.memory === '512M' ? 'selected' : ''}>512 MB</option>
                    <option value="1G" ${props.qemu.memory === '1G' ? 'selected' : ''}>1 GB</option>
                    <option value="2G" ${props.qemu.memory === '2G' ? 'selected' : ''}>2 GB</option>
                    <option value="4G" ${props.qemu.memory === '4G' ? 'selected' : ''}>4 GB</option>
                </select>
            </div>

            <div class="field">
                <label class="field-label">Machine Type</label>
                <select id="qemuMachineType" class="field-input">
                    ${props.targetArch === 'x64' ? `
                        <option value="q35" ${props.qemu.machineType === 'q35' ? 'selected' : ''}>Q35 (Modern chipset)</option>
                        <option value="pc" ${props.qemu.machineType === 'pc' ? 'selected' : ''}>PC (Legacy i440FX)</option>
                    ` : `
                        <option value="virt" ${props.qemu.machineType === 'virt' ? 'selected' : ''}>Virt (ARM Virtual Machine)</option>
                    `}
                </select>
            </div>

            <div class="field">
                <label class="field-label">CPU Model</label>
                <select id="qemuCpuModel" class="field-input">
                    ${props.targetArch === 'x64' ? `
                        <option value="max" ${props.qemu.cpuModel === 'max' ? 'selected' : ''}>Max (All features)</option>
                        <option value="qemu64" ${props.qemu.cpuModel === 'qemu64' ? 'selected' : ''}>QEMU64 (Basic)</option>
                        <option value="host" ${props.qemu.cpuModel === 'host' ? 'selected' : ''}>Host (Pass-through)</option>
                    ` : `
                        <option value="cortex-a72" ${props.qemu.cpuModel === 'cortex-a72' ? 'selected' : ''}>Cortex-A72</option>
                        <option value="cortex-a53" ${props.qemu.cpuModel === 'cortex-a53' ? 'selected' : ''}>Cortex-A53</option>
                        <option value="max" ${props.qemu.cpuModel === 'max' ? 'selected' : ''}>Max (All features)</option>
                    `}
                </select>
            </div>

            <div class="field">
                <label class="field-label">Serial Output</label>
                <select id="qemuSerialMode" class="field-input">
                    <option value="stdio" ${props.qemu.serialMode === 'stdio' ? 'selected' : ''}>Standard I/O (Output panel)</option>
                    <option value="none" ${props.qemu.serialMode === 'none' ? 'selected' : ''}>Disabled</option>
                </select>
            </div>

            <div class="toggle-field">
                <div class="toggle-info">
                    <div class="toggle-label">Network Support</div>
                    <div class="toggle-hint">Enable E1000 network card with user-mode networking</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="qemuEnableNetwork" ${props.qemu.enableNetwork ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="field" id="networkPortsField" style="margin-top: 16px; ${props.qemu.enableNetwork ? '' : 'display: none;'}">
                <label class="field-label">Port Forwards (UDP)</label>
                <input type="text" id="qemuNetworkPorts" class="field-input" value="${props.qemu.networkPorts}" placeholder="5555,5556">
                <div class="field-hint">Comma-separated ports forwarded from host to guest</div>
            </div>

            <div class="field" style="margin-top: 16px;">
                <label class="field-label">Extra Arguments</label>
                <input type="text" id="qemuExtraArgs" class="field-input" value="${props.qemu.extraArgs}" placeholder="-device ich9-ahci">
                <div class="field-hint">Additional QEMU command line arguments</div>
            </div>
            </div>
        </div>

        <div class="section collapsed" id="section-packages">
            <div class="section-title" onclick="toggleSection('section-packages')"><span>Packages</span><span class="chevron">▼</span></div>
            <div class="section-content">
            <div class="packages">
                ${props.packages.length > 0 ? props.packages.map(p => `
                    <div class="package">
                        <span class="package-name">${p.name}</span>
                        <span class="package-version">${p.version}</span>
                    </div>
                `).join('') : '<div class="empty-packages">No additional packages</div>'}
            </div>
            </div>
        </div>

    </div>

    <script>
        function toggleSection(id) {
            const section = document.getElementById(id);
            section.classList.toggle('collapsed');
        }

        const vscode = acquireVsCodeApi();
        let saveTimeout;
        let qemuSaveTimeout;

        function save() {
            const properties = {
                targetFramework: document.getElementById('targetFramework').value,
                targetArch: document.getElementById('targetArch').value,
                kernelClass: document.getElementById('kernelClass').value,
                enableGraphics: document.getElementById('enableGraphics').checked,
                gccFlags: document.getElementById('gccFlags').value,
                defaultFont: document.getElementById('defaultFont').value
            };
            vscode.postMessage({ command: 'save', properties });
            showSaveStatus('Saved');
        }

        function saveQemu() {
            const qemu = {
                memory: document.getElementById('qemuMemory').value,
                machineType: document.getElementById('qemuMachineType').value,
                cpuModel: document.getElementById('qemuCpuModel').value,
                serialMode: document.getElementById('qemuSerialMode').value,
                enableNetwork: document.getElementById('qemuEnableNetwork').checked,
                networkPorts: document.getElementById('qemuNetworkPorts').value,
                extraArgs: document.getElementById('qemuExtraArgs').value
            };
            vscode.postMessage({ command: 'saveQemu', qemu });
            showSaveStatus('Saved');
        }

        function showSaveStatus(text) {
            const status = document.getElementById('saveStatus');
            status.textContent = text;
            status.style.opacity = 1;
            setTimeout(() => { status.style.opacity = 0; }, 2000);
        }

        function onInputChange() {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(save, 300);
        }

        function onQemuInputChange() {
            clearTimeout(qemuSaveTimeout);
            qemuSaveTimeout = setTimeout(saveQemu, 300);
        }

        // Auto-save on any input change
        document.getElementById('targetFramework').addEventListener('change', save);
        document.getElementById('targetArch').addEventListener('change', save);
        document.getElementById('kernelClass').addEventListener('input', onInputChange);
        document.getElementById('enableGraphics').addEventListener('change', save);
        document.getElementById('gccFlags').addEventListener('input', onInputChange);
        document.getElementById('defaultFont').addEventListener('input', onInputChange);

        // QEMU config auto-save
        document.getElementById('qemuMemory').addEventListener('change', saveQemu);
        document.getElementById('qemuMachineType').addEventListener('change', saveQemu);
        document.getElementById('qemuCpuModel').addEventListener('change', saveQemu);
        document.getElementById('qemuSerialMode').addEventListener('change', saveQemu);
        document.getElementById('qemuEnableNetwork').addEventListener('change', function() {
            const portsField = document.getElementById('networkPortsField');
            portsField.style.display = this.checked ? 'block' : 'none';
            saveQemu();
        });
        document.getElementById('qemuNetworkPorts').addEventListener('input', onQemuInputChange);
        document.getElementById('qemuExtraArgs').addEventListener('input', onQemuInputChange);

        function openCsproj() {
            vscode.postMessage({ command: 'openCsproj' });
        }
    </script>
</body>
</html>`;
}
