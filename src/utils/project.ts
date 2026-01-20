import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function findCsprojFiles(dir: string, depth: number = 0): string[] {
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
    } catch { } // Ignore errors like permission denied

    return results;
}

export function isCosmosProject(): boolean {
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
            } catch { } // Ignore errors like file not found or read errors
        }
    }
    return false;
}

export function updateCosmosProjectContext() {
    const isCosmos = isCosmosProject();
    vscode.commands.executeCommand('setContext', 'cosmos:isCosmosProject', isCosmos);
}

export function getProjectInfo(): { name: string; arch: string; csproj: string } | null {
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
                        } catch { } // Ignore errors parsing config file
                    }

                    return {
                        name: path.basename(csproj, '.csproj'),
                        arch: arch,
                        csproj: csproj
                    };
                }
            } catch { } // Ignore errors reading csproj file
        }
    }
    return null;
}

export interface QemuConfig {
    memory: string;
    machineType: string;
    cpuModel: string;
    enableNetwork: boolean;
    networkPorts: string;
    serialMode: string;
    extraArgs: string;
}

export interface ProjectProperties {
    name: string;
    targetFramework: string;
    targetArch: string;
    kernelClass: string;
    enableGraphics: boolean;
    enableKeyboard: boolean;
    enableNetwork: boolean;
    enableScheduler: boolean;
    gccFlags: string;
    packages: { name: string; version: string }[];
    qemu: QemuConfig;
}

export function getDefaultQemuConfig(arch: string): QemuConfig {
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

export function loadQemuConfig(projectDir: string, arch: string): QemuConfig {
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
    } catch { } // Ignore errors parsing config file

    return defaults;
}

export function saveQemuConfig(projectDir: string, qemu: QemuConfig): void {
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
    } catch { } // Ignore errors reading existing config file

    config.qemu = qemu;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function parseProjectProperties(csprojPath: string): ProjectProperties {
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
        } catch { } // Ignore errors parsing config file
    }

    return {
        name,
        targetFramework: getProperty('TargetFramework') || 'net10.0',
        targetArch,
        kernelClass: getProperty('CosmosKernelClass') || `${name}.Kernel`,
        enableGraphics: getProperty('CosmosEnableGraphics') !== 'false',
        enableKeyboard: getProperty('CosmosEnableKeyboard') !== 'false',
        enableNetwork: getProperty('CosmosEnableNetwork') !== 'false',
        enableScheduler: getProperty('CosmosEnableScheduler') !== 'false',
        gccFlags: getProperty('GCCCompilerFlags') || '',
        packages,
        qemu: loadQemuConfig(projectDir, targetArch)
    };
}

export function saveProjectProperties(csprojPath: string, props: ProjectProperties): void {
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
        content = content.replace(new RegExp(`\s*<${prop}>[^<]*</${prop}>`, 'g'), '');
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
    } catch { } // Ignore errors reading existing config file
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

    if (props.enableGraphics) {
        removeProperty('CosmosEnableGraphics');
    } else {
        setProperty('CosmosEnableGraphics', 'false');
    }

    if (props.enableKeyboard) {
        removeProperty('CosmosEnableKeyboard');
    } else {
        setProperty('CosmosEnableKeyboard', 'false');
    }

    if (props.enableNetwork) {
        removeProperty('CosmosEnableNetwork');
    } else {
        setProperty('CosmosEnableNetwork', 'false');
    }

    if (props.enableScheduler) {
        removeProperty('CosmosEnableScheduler');
    } else {
        setProperty('CosmosEnableScheduler', 'false');
    }

    fs.writeFileSync(csprojPath, content);
}
