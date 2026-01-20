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
                    <div class="toggle-label">Keyboard Support</div>
                    <div class="toggle-hint">Keyboard input handling</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableKeyboard" ${props.enableKeyboard ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field">
                <div class="toggle-info">
                    <div class="toggle-label">Network Support</div>
                    <div class="toggle-hint">Network stack and drivers</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableNetwork" ${props.enableNetwork ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field">
                <div class="toggle-info">
                    <div class="toggle-label">Scheduler Support</div>
                    <div class="toggle-hint">Process and thread scheduling</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableScheduler" ${props.enableScheduler ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="toggle-field">
                <div class="toggle-info">
                    <div class="toggle-label">Graphic Support</div>
                    <div class="toggle-hint">Enable VGA graphics display</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="enableGraphics" ${props.enableGraphics ? 'checked' : ''}>
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
                enableGraphics: document.getElementById('enableGraphics').checked,
                enableKeyboard: document.getElementById('enableKeyboard').checked,
                enableNetwork: document.getElementById('enableNetwork').checked,
                enableScheduler: document.getElementById('enableScheduler').checked,
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
        document.getElementById('enableKeyboard').addEventListener('change', save);
        document.getElementById('enableGraphics').addEventListener('change', save);
        document.getElementById('enableNetwork').addEventListener('change', save);
        document.getElementById('enableScheduler').addEventListener('change', save);
        document.getElementById('gccFlags').addEventListener('input', onInputChange);

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
