import * as vscode from 'vscode';
import * as path from 'path';
import { getProjectInfo, parseProjectProperties, saveProjectProperties, saveQemuConfig, ProjectProperties } from '../utils/project';
import { ProjectTreeProvider } from '../providers/projectTree';

export function showProjectProperties(context: vscode.ExtensionContext, projectTreeProvider: ProjectTreeProvider) {
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

    // The arch drives which Machine Type / CPU Model / Network Card options the
    // page renders. Those are baked into the HTML at generation time, so a switch
    // has to re-render the panel — tracked here to only do so when it changes.
    let currentArch = props.targetArch;

    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'save':
                    try {
                        saveProjectProperties(projectInfo.csproj, message.properties);
                        vscode.window.showInformationMessage('Project properties saved successfully');
                        projectTreeProvider.refresh();
                        if (message.properties?.targetArch && message.properties.targetArch !== currentArch) {
                            currentArch = message.properties.targetArch;
                            // Re-parse so the arch-dependent dropdowns (and any
                            // values validated against the new arch) refresh.
                            const refreshed = parseProjectProperties(projectInfo.csproj);
                            panel.webview.html = getPropertiesWebviewContent(refreshed, projectInfo.csproj);
                        }
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
            /* Upper bound for the collapse animation. Must exceed the tallest
               section (QEMU Configuration, ~9 fields each with a description) or
               the overflow clips it and the next section rides up over the tail. */
            max-height: 3000px;
            opacity: 1;
        }
        .section.collapsed .section-content {
            max-height: 0;
            opacity: 0;
            margin-bottom: -16px;
        }
        .qemu-columns {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 16px;
            margin-bottom: 16px;
        }
        .qemu-group {
            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.18));
            border-radius: 10px;
            padding: 16px;
            background: var(--vscode-editorWidget-background, rgba(127,127,127,0.05));
            margin-bottom: 16px;
        }
        .qemu-columns .qemu-group {
            margin-bottom: 0;
        }
        .qemu-group > .field:last-child {
            margin-bottom: 0;
        }
        .qemu-group-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 14px;
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
        .disk-row {
            display: flex;
            gap: 8px;
            align-items: center;
            margin-bottom: 8px;
        }
        .disk-row .disk-path {
            flex: 1 1 auto;
        }
        .disk-row .disk-type {
            flex: 0 0 96px;
        }
        .disk-row .disk-size {
            flex: 0 0 84px;
        }
        .disk-remove {
            flex: 0 0 auto;
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 15px;
            line-height: 1;
            padding: 6px 8px;
            border-radius: 6px;
        }
        .disk-remove:hover {
            color: var(--vscode-errorForeground);
            background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
        }
        .add-disk-btn {
            margin-top: 4px;
            background: var(--vscode-button-secondaryBackground, transparent);
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
            border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
            padding: 6px 12px;
            font-size: 13px;
            border-radius: 6px;
            cursor: pointer;
        }
        .add-disk-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.15));
        }
        .disk-empty {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
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
        .toggle-field.hidden {
            display: none;
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
                    <div class="toggle-label">Interrupts</div>
                    <div class="toggle-hint">Interrupt support, disabling also disables Timer, Keyboard, Mouse, Network, Scheduler, PCI, Storage</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableInterrupts" ${props.enableInterrupts ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field toggle-child" id="field-timer">
                <div class="toggle-info">
                    <div class="toggle-label">Timer</div>
                    <div class="toggle-hint">Timers support, disabling also disables Scheduler</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableTimer" ${props.enableTimer ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field toggle-child" id="field-keyboard">
                <div class="toggle-info">
                    <div class="toggle-label">Keyboard Support</div>
                    <div class="toggle-hint">Keyboard input handling</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableKeyboard" ${props.enableKeyboard ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field toggle-child" id="field-mouse">
                <div class="toggle-info">
                    <div class="toggle-label">Mouse Support</div>
                    <div class="toggle-hint">Mouse input handling</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableMouse" ${props.enableMouse ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field toggle-child" id="field-network">
                <div class="toggle-info">
                    <div class="toggle-label">Network Support</div>
                    <div class="toggle-hint">Network stack and drivers</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableNetwork" ${props.enableNetwork ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field toggle-child toggle-grandchild" id="field-scheduler">
                <div class="toggle-info">
                    <div class="toggle-label">Scheduler Support</div>
                    <div class="toggle-hint">Process and thread scheduling</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableScheduler" ${props.enableScheduler ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field toggle-child" id="field-pci">
                <div class="toggle-info">
                    <div class="toggle-label">PCI Support</div>
                    <div class="toggle-hint">PCI/PCIe bus enumeration. Every PCI device driver needs it — E1000E, AHCI, NVMe, and VirtIO over PCI. Disabling also disables Storage</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enablePCI" ${props.enablePCI ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field toggle-child toggle-grandchild" id="field-storage">
                <div class="toggle-info">
                    <div class="toggle-label">Storage Support</div>
                    <div class="toggle-hint">AHCI/SATA and NVMe block devices. Disabling also disables FAT</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableStorage" ${props.enableStorage ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field toggle-child toggle-grandchild" id="field-fat">
                <div class="toggle-info">
                    <div class="toggle-label">FAT Filesystem</div>
                    <div class="toggle-hint">FAT filesystem support, mounted on a storage block device</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableFat" ${props.enableFat ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field" id="field-graphics">
                <div class="toggle-info">
                    <div class="toggle-label">Graphic Support</div>
                    <div class="toggle-hint">Enable graphics display</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableGraphics" ${props.enableGraphics ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field" id="field-uart">
                <div class="toggle-info">
                    <div class="toggle-label">UART / Serial</div>
                    <div class="toggle-hint">Serial port output. Disabling it silences the serial console the debugger and test runner read</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableUART" ${props.enableUART ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
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

            <div class="qemu-columns">
            <div class="qemu-group">
            <div class="qemu-group-title">Machine</div>

            <div class="field">
                <label class="field-label">Memory</label>
                <select id="qemuMemory" class="field-input">
                    <option value="256M" ${props.qemu.memory === '256M' ? 'selected' : ''}>256 MB</option>
                    <option value="512M" ${props.qemu.memory === '512M' ? 'selected' : ''}>512 MB</option>
                    <option value="1G" ${props.qemu.memory === '1G' ? 'selected' : ''}>1 GB</option>
                    <option value="2G" ${props.qemu.memory === '2G' ? 'selected' : ''}>2 GB</option>
                    <option value="4G" ${props.qemu.memory === '4G' ? 'selected' : ''}>4 GB</option>
                </select>
                <div class="field-hint">How much RAM the virtual machine gives your kernel. More lets the kernel allocate more, but uses more host memory.</div>
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
                <div class="field-hint">The emulated motherboard/chipset that decides which built-in devices exist. ${props.targetArch === 'x64' ? 'Q35 is the modern default; PC is the legacy i440FX.' : 'arm64 uses the generic ARM virt machine.'}</div>
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
                <div class="field-hint">Which processor QEMU emulates for the guest. ${props.targetArch === 'x64' ? '&quot;Max&quot; exposes every CPU feature QEMU supports; &quot;Host&quot; passes your real CPU through (fastest, needs KVM).' : 'Cortex-A72/A53 are common ARM cores; &quot;Max&quot; enables all features.'}</div>
            </div>

            <div class="field">
                <label class="field-label">Serial Output</label>
                <select id="qemuSerialMode" class="field-input">
                    <option value="stdio" ${props.qemu.serialMode === 'stdio' ? 'selected' : ''}>Standard I/O (Output panel)</option>
                    <option value="none" ${props.qemu.serialMode === 'none' ? 'selected' : ''}>Disabled</option>
                </select>
                <div class="field-hint">Where the kernel's serial console goes — the text from Console.Write / Serial output. &quot;Standard I/O&quot; streams it into the VS Code Output panel.</div>
            </div>
            </div>

            <div class="qemu-group">
            <div class="qemu-group-title">Devices</div>

            <div class="field">
                <label class="field-label">Network Card</label>
                <select id="qemuNetworkCard" class="field-input">
                    <option value="none" ${props.qemu.networkCard === 'none' ? 'selected' : ''}>None (no network card)</option>
                    ${props.targetArch === 'x64' ? `
                        <option value="e1000e" ${props.qemu.networkCard === 'e1000e' ? 'selected' : ''}>Intel E1000E (PCIe)</option>
                        <option value="virtio-net-pci" ${props.qemu.networkCard === 'virtio-net-pci' ? 'selected' : ''}>VirtIO (virtio-net-pci)</option>
                        <option value="e1000" disabled>Intel E1000 — no driver</option>
                        <option value="rtl8139" disabled>Realtek RTL8139 — no driver</option>
                    ` : `
                        <option value="virtio-net-device" ${props.qemu.networkCard === 'virtio-net-device' ? 'selected' : ''}>VirtIO (virtio-net-device)</option>
                        <option value="e1000e" disabled>Intel E1000E — x64 only</option>
                    `}
                </select>
                <div class="field-hint">The network adapter the kernel sees. Pick &quot;None&quot; for no networking; cards without a kernel driver are grayed out. Supported: ${props.targetArch === 'x64' ? 'Intel E1000E and VirtIO over PCI — VirtIO needs PCI enabled' : 'VirtIO over MMIO (virtio-net-device)'}.</div>
            </div>

            <div class="field">
                <label class="field-label">Keyboard</label>
                <select id="qemuKeyboard" class="field-input">
                    <option value="none" ${props.qemu.keyboard === 'none' ? 'selected' : ''}>None (no keyboard)</option>
                    ${props.targetArch === 'x64' ? `
                        <option value="ps2" ${props.qemu.keyboard === 'ps2' ? 'selected' : ''}>PS/2 (i8042)</option>
                        <option value="virtio-keyboard-pci" ${props.qemu.keyboard === 'virtio-keyboard-pci' ? 'selected' : ''}>VirtIO Keyboard (PCI)</option>
                        <option value="virtio-keyboard-device" disabled>VirtIO Keyboard (MMIO) — arm64 only</option>
                    ` : `
                        <option value="virtio-keyboard-device" ${props.qemu.keyboard === 'virtio-keyboard-device' ? 'selected' : ''}>VirtIO Keyboard (MMIO)</option>
                        <option value="ps2" disabled>PS/2 — virt has no i8042</option>
                    `}
                </select>
                <div class="field-hint">The keyboard device the kernel reads input from. Devices without a kernel driver are grayed out. Supported: ${props.targetArch === 'x64' ? 'PS/2 (built into the q35 chipset) and VirtIO over PCI — VirtIO needs PCI enabled' : 'VirtIO over MMIO (the arm64 virt machine has no PS/2)'}.</div>
            </div>

            <div class="field">
                <label class="field-label">Mouse</label>
                <select id="qemuMouse" class="field-input">
                    <option value="none" ${props.qemu.mouse === 'none' ? 'selected' : ''}>None (no mouse)</option>
                    ${props.targetArch === 'x64' ? `
                        <option value="ps2" ${props.qemu.mouse === 'ps2' ? 'selected' : ''}>PS/2 (i8042)</option>
                        <option value="virtio-mouse-pci" ${props.qemu.mouse === 'virtio-mouse-pci' ? 'selected' : ''}>VirtIO Mouse (PCI)</option>
                        <option value="virtio-mouse-device" disabled>VirtIO Mouse (MMIO) — arm64 only</option>
                    ` : `
                        <option value="virtio-mouse-device" ${props.qemu.mouse === 'virtio-mouse-device' ? 'selected' : ''}>VirtIO Mouse (MMIO)</option>
                        <option value="ps2" disabled>PS/2 — virt has no i8042</option>
                    `}
                </select>
                <div class="field-hint">The pointing device the kernel reads. Devices without a kernel driver are grayed out. Supported: ${props.targetArch === 'x64' ? 'PS/2 (built into the q35 chipset) and VirtIO over PCI — VirtIO needs PCI enabled' : 'VirtIO over MMIO (the arm64 virt machine has no PS/2)'}.</div>
            </div>
            </div>
            </div>

            <div class="qemu-group">
            <div class="qemu-group-title">Storage</div>

            <div class="field">
                <label class="field-label">Disks</label>
                <div class="field-hint" style="margin-top:0; margin-bottom:10px;">Disk images attached to the kernel at boot. A missing image is created at the given size on launch. Paths are relative to the project folder.</div>
                <div id="diskList"></div>
                <button type="button" class="add-disk-btn" onclick="addDisk()">+ Add Disk</button>
            </div>
            </div>

            <div class="qemu-group">
            <div class="qemu-group-title">Advanced</div>

            <div class="field">
                <label class="field-label">Extra Arguments</label>
                <input type="text" id="qemuExtraArgs" class="field-input" value="${props.qemu.extraArgs}" placeholder="-device ich9-ahci">
                <div class="field-hint">Raw flags appended to the QEMU launch command, for advanced options not covered above (e.g. <code>-device …</code>). Leave empty if unsure.</div>
            </div>
            </div>
            </div>
        </div>

        <div class="section" id="section-packages">
            <div class="section-title"><span>Packages</span></div>
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
                enableInterrupts: document.getElementById('enableInterrupts').checked,
                enableTimer: document.getElementById('enableTimer').checked,
                enableGraphics: document.getElementById('enableGraphics').checked,
                enableKeyboard: document.getElementById('enableKeyboard').checked,
                enableMouse: document.getElementById('enableMouse').checked,
                enableNetwork: document.getElementById('enableNetwork').checked,
                enableScheduler: document.getElementById('enableScheduler').checked,
                enableUART: document.getElementById('enableUART').checked,
                enablePCI: document.getElementById('enablePCI').checked,
                enableStorage: document.getElementById('enableStorage').checked,
                enableFat: document.getElementById('enableFat').checked,
                gccFlags: document.getElementById('gccFlags').value
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
                networkCard: document.getElementById('qemuNetworkCard').value,
                keyboard: document.getElementById('qemuKeyboard').value,
                mouse: document.getElementById('qemuMouse').value,
                // Legacy network toggle/ports are no longer editable in this panel;
                // preserve whatever the project already had so saving doesn't wipe it.
                enableNetwork: ${props.qemu.enableNetwork},
                networkPorts: ${JSON.stringify(props.qemu.networkPorts)},
                extraArgs: document.getElementById('qemuExtraArgs').value,
                // Persist only rows that name a path; blank rows are UI scratch.
                disks: disks.filter(d => d.path && d.path.trim()).map(d => ({
                    path: d.path.trim(),
                    type: d.type === 'nvme' ? 'nvme' : 'ahci',
                    size: (d.size && d.size.trim()) ? d.size.trim() : '256M'
                }))
            };
            vscode.postMessage({ command: 'saveQemu', qemu });
            showSaveStatus('Saved');
        }

        // Disks are edited as an in-memory list and re-rendered on every change,
        // so indices stay stable across add/remove without per-row DOM surgery.
        let disks = ${JSON.stringify(props.qemu.disks || [])};

        function escapeAttr(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function renderDisks() {
            const container = document.getElementById('diskList');
            container.innerHTML = '';
            if (disks.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'disk-empty';
                empty.textContent = 'No disks attached.';
                container.appendChild(empty);
            }
            disks.forEach((d, i) => {
                const row = document.createElement('div');
                row.className = 'disk-row';
                row.innerHTML =
                    '<input type="text" class="field-input disk-path" placeholder="disk.img" ' +
                        'value="' + escapeAttr(d.path) + '" data-i="' + i + '" data-k="path">' +
                    '<select class="field-input disk-type" data-i="' + i + '" data-k="type">' +
                        '<option value="ahci"' + (d.type === 'ahci' ? ' selected' : '') + '>AHCI</option>' +
                        '<option value="nvme"' + (d.type === 'nvme' ? ' selected' : '') + '>NVMe</option>' +
                    '</select>' +
                    '<input type="text" class="field-input disk-size" placeholder="256M" ' +
                        'value="' + escapeAttr(d.size) + '" data-i="' + i + '" data-k="size">' +
                    '<button type="button" class="disk-remove" title="Remove disk" data-i="' + i + '">✕</button>';
                container.appendChild(row);
            });
            container.querySelectorAll('.disk-path, .disk-size').forEach(function (el) {
                el.addEventListener('input', onDiskFieldChange);
            });
            container.querySelectorAll('.disk-type').forEach(function (el) {
                el.addEventListener('change', onDiskFieldChange);
            });
            container.querySelectorAll('.disk-remove').forEach(function (el) {
                el.addEventListener('click', function () {
                    disks.splice(parseInt(el.dataset.i, 10), 1);
                    renderDisks();
                    saveQemu();
                });
            });
        }

        function onDiskFieldChange(e) {
            const el = e.target;
            disks[parseInt(el.dataset.i, 10)][el.dataset.k] = el.value;
            onQemuInputChange();
        }

        function addDisk() {
            disks.push({ path: '', type: 'ahci', size: '256M' });
            renderDisks();
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

        // Mirrors the cascade in Sdk.targets, which is what the build actually
        // applies. Graphics and UART are deliberately absent: the SDK never
        // cascades them, so hiding them here would tell the user a feature was
        // turned off while the build kept it on.
        function updateFeatureVisibility() {
            const interruptsOn = document.getElementById('enableInterrupts').checked;
            const timerOn = interruptsOn && document.getElementById('enableTimer').checked;
            const pciOn = interruptsOn && document.getElementById('enablePCI').checked;
            const storageOn = pciOn && document.getElementById('enableStorage').checked;

            const interruptChildren = ['field-timer', 'field-keyboard', 'field-mouse', 'field-network', 'field-pci'];
            for (const id of interruptChildren) {
                document.getElementById(id).classList.toggle('hidden', !interruptsOn);
            }
            document.getElementById('field-scheduler').classList.toggle('hidden', !timerOn);
            document.getElementById('field-storage').classList.toggle('hidden', !pciOn);
            document.getElementById('field-fat').classList.toggle('hidden', !storageOn);
        }

        // Auto-save on any input change
        document.getElementById('targetFramework').addEventListener('change', save);
        document.getElementById('targetArch').addEventListener('change', save);
        document.getElementById('kernelClass').addEventListener('input', onInputChange);
        document.getElementById('enableInterrupts').addEventListener('change', function() { updateFeatureVisibility(); save(); });
        document.getElementById('enableTimer').addEventListener('change', function() { updateFeatureVisibility(); save(); });
        document.getElementById('enableKeyboard').addEventListener('change', save);
        document.getElementById('enableMouse').addEventListener('change', save);
        document.getElementById('enableGraphics').addEventListener('change', save);
        document.getElementById('enableNetwork').addEventListener('change', save);
        document.getElementById('enableScheduler').addEventListener('change', save);
        document.getElementById('enablePCI').addEventListener('change', function() { updateFeatureVisibility(); save(); });
        document.getElementById('enableStorage').addEventListener('change', function() { updateFeatureVisibility(); save(); });
        document.getElementById('enableFat').addEventListener('change', save);
        document.getElementById('enableUART').addEventListener('change', save);
        document.getElementById('gccFlags').addEventListener('input', onInputChange);

        // Set initial visibility based on current csproj state
        updateFeatureVisibility();

        // QEMU config auto-save
        document.getElementById('qemuMemory').addEventListener('change', saveQemu);
        document.getElementById('qemuMachineType').addEventListener('change', saveQemu);
        document.getElementById('qemuCpuModel').addEventListener('change', saveQemu);
        document.getElementById('qemuSerialMode').addEventListener('change', saveQemu);
        document.getElementById('qemuNetworkCard').addEventListener('change', saveQemu);
        document.getElementById('qemuKeyboard').addEventListener('change', saveQemu);
        document.getElementById('qemuMouse').addEventListener('change', saveQemu);
        document.getElementById('qemuExtraArgs').addEventListener('input', onQemuInputChange);

        // Render the disk list from the loaded config.
        renderDisks();

        function openCsproj() {
            vscode.postMessage({ command: 'openCsproj' });
        }
    </script>
</body>
</html>`;
}
