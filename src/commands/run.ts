import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getProjectInfo, parseProjectProperties } from '../utils/project';
import { getPlatformInfo } from '../utils/cosmos';
import { getEnvWithDotnetTools, getCommandPath } from '../utils/execution';
import { getOutputChannel } from '../utils/output';
import { buildCommand } from './build';
import { runDebugAdapterFactory } from '../extension';
import { LogProcessor } from '../utils/logProcessor';

export async function runCommand(arch?: string) {
    const outputChannel = getOutputChannel();
    const processor = new LogProcessor(outputChannel);

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
    
    // Get project properties for graphics setting
    const props = parseProjectProperties(projectInfo.csproj);
    const qemuConfig = props.qemu;
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
            '-display', !props.enableGraphics ? 'none' : platformInfo.qemuDisplay,
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
            '-display', !props.enableGraphics ? 'none' : `${platformInfo.qemuDisplay},show-cursor=on`,
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

    // Resolve QEMU path for process control
    const resolvedQemuCmd = getCommandPath(qemuCmd) || qemuCmd;

    // Show output in the output channel
    outputChannel.show(true);
    outputChannel.clear();
    outputChannel.appendLine(`Running ${projectInfo.name} (${arch}) in QEMU...`);
    outputChannel.appendLine(`Platform: ${platformInfo.platformName}`);
    outputChannel.appendLine('');
    outputChannel.appendLine(`> ${resolvedQemuCmd} ${qemuArgs.join(' ')}`);
    outputChannel.appendLine('');

    const qemuProcess = spawn(resolvedQemuCmd, qemuArgs, {
        cwd: projectDir,
        env: getEnvWithDotnetTools(),
        shell: false
    });

    qemuProcess.stdout?.on('data', (data) => processor.append(data));
    qemuProcess.stderr?.on('data', (data) => processor.append(data));

    qemuProcess.on('close', (code) => {
        processor.flush();
        outputChannel.appendLine('');
        outputChannel.appendLine(`QEMU exited with code ${code}`);
    });

    qemuProcess.on('error', (err) => {
        outputChannel.appendLine(`Error: ${err.message}`);
        vscode.window.showErrorMessage(`QEMU error: ${err.message}`);
    });

    // Use our custom debug adapter to provide the stop button
    runDebugAdapterFactory.setProcess(qemuProcess);
    
    await vscode.debug.startDebugging(undefined, {
        name: `Run ${projectInfo.name}`,
        type: 'cosmos-run',
        request: 'launch',
        internalConsoleOptions: 'neverOpen'
    });

    // Keep focus on Cosmos view
    vscode.commands.executeCommand('workbench.view.extension.cosmos');
}