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

export interface DiskConfig {
    // Image path, absolute or relative to the project directory.
    path: string;
    // Controller the guest sees the disk through.
    type: 'ahci' | 'nvme';
    // Size used only when the image has to be created (e.g. "256M", "1G").
    size: string;
}

export interface QemuConfig {
    memory: string;
    machineType: string;
    cpuModel: string;
    enableNetwork: boolean;
    networkPorts: string;
    serialMode: string;
    // QEMU NIC model exposed to the guest, or 'none' for no network card.
    networkCard: string;
    // Keyboard device: 'ps2' (x64 chipset), 'virtio-keyboard-device' (arm64), or 'none'.
    keyboard: string;
    // Mouse device: 'ps2' (x64 chipset), 'virtio-mouse-device' (arm64), or 'none'.
    mouse: string;
    extraArgs: string;
    // Disk images attached to the kernel at boot. Empty by default.
    disks: DiskConfig[];
}

export interface ProjectProperties {
    name: string;
    targetFramework: string;
    targetArch: string;
    kernelClass: string;
    enableInterrupts: boolean;
    enableTimer: boolean;
    enableGraphics: boolean;
    enableKeyboard: boolean;
    enableMouse: boolean;
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
        networkCard: 'none',
        // x64 gets PS/2 from the chipset; arm64 virt needs virtio-input devices.
        keyboard: arch === 'arm64' ? 'virtio-keyboard-device' : 'ps2',
        mouse: arch === 'arm64' ? 'virtio-mouse-device' : 'ps2',
        extraArgs: '',
        disks: []
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

    // NIC models with a kernel driver, per architecture ('none' = no card).
    // The kernel only ships E1000E (x64) and VirtioNet (arm64), so anything
    // else is rejected back to 'none' rather than persisted.
    const x64NetworkCards = ['none', 'e1000e'];
    const arm64NetworkCards = ['none', 'virtio-net-device'];

    // Input devices with a kernel driver, per architecture. x64 has PS/2
    // (i8042) drivers; arm64 virt has no PS/2 controller and uses virtio-input.
    const x64Keyboards = ['ps2', 'none'];
    const arm64Keyboards = ['virtio-keyboard-device', 'none'];
    const x64Mice = ['ps2', 'none'];
    const arm64Mice = ['virtio-mouse-device', 'none'];

    try {
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(content);
            const merged = { ...defaults, ...config.qemu };

            // Disks may be absent or malformed in older configs; normalize to a
            // clean array so consumers never have to defend against it.
            if (!Array.isArray(merged.disks)) {
                merged.disks = [];
            } else {
                merged.disks = merged.disks
                    .filter((d: any) => d && typeof d.path === 'string')
                    .map((d: any) => ({
                        path: d.path,
                        type: d.type === 'nvme' ? 'nvme' : 'ahci',
                        size: typeof d.size === 'string' && d.size.trim() ? d.size : '256M'
                    }));
            }

            // Validate machine type matches architecture
            if (arch === 'arm64') {
                if (!arm64MachineTypes.includes(merged.machineType)) {
                    merged.machineType = defaults.machineType;
                }
                if (!arm64CpuModels.includes(merged.cpuModel)) {
                    merged.cpuModel = defaults.cpuModel;
                }
                if (!arm64NetworkCards.includes(merged.networkCard)) {
                    merged.networkCard = defaults.networkCard;
                }
                if (!arm64Keyboards.includes(merged.keyboard)) {
                    merged.keyboard = defaults.keyboard;
                }
                if (!arm64Mice.includes(merged.mouse)) {
                    merged.mouse = defaults.mouse;
                }
            } else {
                if (!x64MachineTypes.includes(merged.machineType)) {
                    merged.machineType = defaults.machineType;
                }
                if (!x64CpuModels.includes(merged.cpuModel)) {
                    merged.cpuModel = defaults.cpuModel;
                }
                if (!x64NetworkCards.includes(merged.networkCard)) {
                    merged.networkCard = defaults.networkCard;
                }
                if (!x64Keyboards.includes(merged.keyboard)) {
                    merged.keyboard = defaults.keyboard;
                }
                if (!x64Mice.includes(merged.mouse)) {
                    merged.mouse = defaults.mouse;
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
        enableInterrupts: getProperty('CosmosEnableInterrupts') !== 'false',
        enableTimer: getProperty('CosmosEnableTimer') !== 'false',
        enableGraphics: getProperty('CosmosEnableGraphics') !== 'false',
        enableKeyboard: getProperty('CosmosEnableKeyboard') !== 'false',
        enableMouse: getProperty('CosmosEnableMouse') !== 'false',
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

    if (props.enableInterrupts) {
        removeProperty('CosmosEnableInterrupts');
    } else {
        setProperty('CosmosEnableInterrupts', 'false');
    }

    if (props.enableTimer) {
        removeProperty('CosmosEnableTimer');
    } else {
        setProperty('CosmosEnableTimer', 'false');
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

    if (props.enableMouse) {
        removeProperty('CosmosEnableMouse');
    } else {
        setProperty('CosmosEnableMouse', 'false');
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
