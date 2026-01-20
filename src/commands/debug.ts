import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { getProjectInfo, loadQemuConfig, parseProjectProperties } from '../utils/project';
import { getPlatformInfo } from '../utils/cosmos';
import { getEnvWithDotnetTools, getCommandPath } from '../utils/execution';
import { getOutputChannel } from '../utils/output';
import { buildCommand } from './build';

let activeQemuProcess: ChildProcess | undefined;

export function onDebugSessionTerminated(session: vscode.DebugSession) {
    if (activeQemuProcess && session.type === 'cppdbg' && session.name.startsWith('Debug ')) {
        if (!activeQemuProcess.killed) {
            activeQemuProcess.kill();
        }
        activeQemuProcess = undefined;
        // Switch back to Cosmos view
        vscode.commands.executeCommand('workbench.view.extension.cosmos');
    }
}

export async function debugCommand(arch?: string) {
    const outputChannel = getOutputChannel();
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
    // Get project properties for graphics setting
    const props = parseProjectProperties(projectInfo.csproj);
    const qemuConfig = props.qemu;
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
            '-display', !props.enableGraphics ? 'none' : platformInfo.qemuDisplay,
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
            '-display', !props.enableGraphics ? 'none' : `${platformInfo.qemuDisplay},show-cursor=on`,
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

    // Resolve QEMU path for process control
    const resolvedQemuCmd = getCommandPath(qemuCmd) || qemuCmd;

    // Show output in the output channel
    outputChannel.show(true);
    outputChannel.clear();
    outputChannel.appendLine(`Debugging ${projectInfo.name} (${arch}) with GDB`);
    outputChannel.appendLine(`GDB server port: ${gdbPort}`);
    outputChannel.appendLine(`ELF: ${elfPath}`);
    outputChannel.appendLine('');
    outputChannel.appendLine(`> ${resolvedQemuCmd} ${qemuArgs.join(' ')}`);
    outputChannel.appendLine('');

    const qemuProcess = spawn(resolvedQemuCmd, qemuArgs, {
        cwd: projectDir,
        env: getEnvWithDotnetTools(),
        shell: false
    });

    activeQemuProcess = qemuProcess;

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
    await vscode.debug.startDebugging(workspaceFolder, debugConfig);

    // Keep focus on Cosmos view
    vscode.commands.executeCommand('workbench.view.extension.cosmos');
}
