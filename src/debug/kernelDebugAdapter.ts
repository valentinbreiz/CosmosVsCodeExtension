import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess, spawnSync } from 'child_process';
import { getCosmosToolsPath, getGdbPath } from '../utils/cosmos';
import { getEnvWithDotnetTools, getCommandPath } from '../utils/execution';
import { resolveKernelElf } from '../utils/kernelArtifacts';
import { isPortInUse } from '../utils/portCheck';
import { parseMemoryMb } from '../utils/qemuOptions';
import { parseProjectProperties } from '../utils/project';

const gdbPythonCache = new Map<string, boolean>();

/**
 * Returns true if `gdbPath` was built with Python AND the `gdb` Python module
 * loads. Python compiled in but missing the data directory (share/gdb/python)
 * counts as no Python — `import gdb` fails so our pretty-printers can't run.
 * Cached across calls since shelling out to gdb is non-trivial.
 */
function gdbBinaryHasPython(gdbPath: string): boolean {
    const cached = gdbPythonCache.get(gdbPath);
    if (cached !== undefined) {
        return cached;
    }
    try {
        const r = spawnSync(gdbPath, ['-batch', '-ex', 'python import gdb; print("ok")'], {
            timeout: 5000,
            encoding: 'utf8'
        });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        const ok = r.status === 0
            && /\bok\b/.test(out)
            && !/Python scripting is not supported/i.test(out)
            && !/No module named 'gdb'/i.test(out);
        gdbPythonCache.set(gdbPath, ok);
        return ok;
    } catch {
        gdbPythonCache.set(gdbPath, false);
        return false;
    }
}

/**
 * Args supplied via launch.json. All optional — we infer everything from the
 * current Cosmos project when missing.
 */
export interface KernelDebugLaunchArgs {
    arch?: string;             // x64 | arm64; defaults to project's configured arch
    projectDir?: string;       // override the workspace project (used for test kernels)
    kernelName?: string;       // override the project name (used for test kernels)
    gdbPort?: number;          // default 1234
}

const GDB_DAP_FRAME_END = Buffer.from('\r\n\r\n');

/**
 * Single inline DAP adapter that owns the cosmos process and proxies all DAP
 * messages between VS Code and our external gdb-mi adapter
 * (cosmosGdbSession.js). When VS Code disconnects, we tear down gdb AND
 * cosmos's whole process group, so QEMU never outlives the session.
 */
export class KernelDebugAdapter implements vscode.DebugAdapter {
    private readonly _sendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this._sendMessage.event;

    private cosmosProc?: ChildProcess;
    private gdbProc?: ChildProcess;
    private gdbBuffer = Buffer.alloc(0);
    private launched = false;
    private terminated = false;

    constructor(
        private readonly extensionPath: string,
        private readonly outputChannel: vscode.OutputChannel
    ) { }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        const msg = message as any;
        if (msg.type === 'request') {
            if (msg.command === 'initialize') {
                this.handleInitialize(msg);
                return;
            }
            if (msg.command === 'launch') {
                this.handleLaunch(msg);
                return;
            }
            if (msg.command === 'disconnect' || msg.command === 'terminate') {
                this.handleDisconnect(msg);
                return;
            }
        }
        // Everything else is forwarded to the gdb adapter unmodified.
        this.forwardToGdb(message);
    }

    dispose(): void {
        this.shutdown('dispose');
    }

    private handleInitialize(req: any): void {
        // We answer initialize ourselves so VS Code can render a session even
        // before gdb is up. Capabilities are intentionally minimal here — the
        // real capabilities are reported by the gdb adapter once it answers
        // its own initialize (we propagate that response by overwriting
        // VS Code's expectations is not straightforward, so for now we expose
        // the union and rely on gdb's later responses for correctness).
        this.respond(req, {
            supportsConfigurationDoneRequest: true,
            supportsConditionalBreakpoints: true,
            supportsFunctionBreakpoints: true,
            supportsHitConditionalBreakpoints: true,
            supportsEvaluateForHovers: true,
            supportsSetVariable: true,
            supportsLogPoints: true,
            supportsTerminateRequest: true
        });
    }

    private async handleLaunch(req: any): Promise<void> {
        if (this.launched) {
            return;
        }
        this.launched = true;
        const args = (req.arguments || {}) as KernelDebugLaunchArgs;

        try {
            await this.startCosmosAndAttach(req, args);
        } catch (err: any) {
            this.outputChannel.appendLine(`[cosmos-debug] failed to start: ${err?.message || err}`);
            this.sendErrorResponse(req, `Failed to start cosmos debug: ${err?.message || err}`);
            this.fireTerminated();
            this.shutdown('launch-error');
        }
    }

    private async startCosmosAndAttach(req: any, args: KernelDebugLaunchArgs): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        const projectInfo = await this.resolveProjectInfo(args);
        if (!projectInfo) {
            throw new Error('No Cosmos project found');
        }

        const arch = args.arch || projectInfo.arch;
        const gdbPort = args.gdbPort ?? 1234;
        const projectDir = projectInfo.projectDir;
        const csproj = projectInfo.csproj;
        const projectName = projectInfo.name;

        const outputDir = path.join(projectDir, `output-${arch}`);
        if (!fs.existsSync(outputDir)) {
            throw new Error(`No build for ${arch} at ${outputDir}. Run \`cosmos build\` first.`);
        }
        const isoFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.iso'));
        if (isoFiles.length === 0) {
            throw new Error(`No ISO in ${outputDir}. Rebuild before debugging.`);
        }
        const isoPath = path.join(outputDir, isoFiles[0]);

        const elfPath = resolveKernelElf(workspaceFolder.uri.fsPath, projectDir, projectName, arch);
        if (!elfPath) {
            throw new Error(`No ELF for ${projectName} (${arch}). Rebuild before debugging.`);
        }

        const cosmosCmd = getCosmosToolsPath();
        if (!cosmosCmd) {
            throw new Error('cosmos CLI not installed. Install Cosmos.Tools as a dotnet global tool.');
        }

        if (await isPortInUse(gdbPort)) {
            throw new Error(
                `Port ${gdbPort} is already in use — a previous debug session left QEMU running. ` +
                `Run \`pkill -f qemu-system\` to clean up.`
            );
        }

        // --headless is mandatory: the bundled QEMU's only graphical backend
        // is SDL, which cannot open a window from the extension host on
        // Wayland sessions, and would kill QEMU immediately on failure.
        const cosmosArgs = ['run', '-a', arch, '--iso', isoPath, '--debug', '--headless'];
        let props;
        try {
            props = parseProjectProperties(csproj);
            const memoryMb = parseMemoryMb(props.qemu.memory);
            if (memoryMb !== null) {
                cosmosArgs.push('-m', String(memoryMb));
            }
        } catch {
            // properties optional — keep going with defaults
        }

        this.outputChannel.show(true);
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine(`Debugging ${projectName} (${arch})`);
        this.outputChannel.appendLine(`ELF: ${elfPath}`);
        this.outputChannel.appendLine(`> ${cosmosCmd} ${cosmosArgs.join(' ')}`);

        this.cosmosProc = spawn(cosmosCmd, cosmosArgs, {
            cwd: projectDir,
            env: getEnvWithDotnetTools(),
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            // detached:true on POSIX → own process group → SIGTERM -pgid takes
            // the whole tree (cosmos + QEMU) down without orphaning.
            detached: process.platform !== 'win32'
        });

        this.cosmosProc.stdout?.on('data', d => this.outputChannel.append(d.toString()));
        this.cosmosProc.stderr?.on('data', d => this.outputChannel.append(d.toString()));
        this.cosmosProc.on('exit', code => {
            this.outputChannel.appendLine(`\ncosmos exited with code ${code}`);
            this.cosmosProc = undefined;
            this.fireTerminated();
        });

        // Wait for QEMU's gdbstub to come up. Poll the port instead of a
        // fixed sleep so the attach happens as soon as it's ready.
        await this.waitForPort(gdbPort, 5000);

        // Pick a gdb with Python support if any candidate has it (needed for
        // the NativeAOT pretty-printers). Cosmos's bundled gdb is currently
        // built --without-python, so fall through to system gdb-multiarch when
        // that's the case. Falls back to "first available" if none have Python.
        const gdbCandidates = [getGdbPath(), getCommandPath('gdb-multiarch'), getCommandPath('gdb')]
            .filter((p): p is string => !!p);
        if (gdbCandidates.length === 0) {
            throw new Error('gdb-multiarch not found. Run `cosmos install --auto --tools`.');
        }
        let gdbPath = gdbCandidates[0];
        let gdbHasPython = false;
        for (const candidate of gdbCandidates) {
            if (gdbBinaryHasPython(candidate)) {
                gdbPath = candidate;
                gdbHasPython = true;
                break;
            }
        }
        this.outputChannel.appendLine(`GDB: ${gdbPath}${gdbHasPython ? '' : ' (no Python — pretty-printers disabled)'}`);

        const setupCommands: string[] = ['gdb-set osabi none'];
        if (arch === 'arm64') {
            setupCommands.push('set architecture aarch64');
        } else {
            setupCommands.push('gdb-set disassembly-flavor intel');
        }

        // Cosmos pretty-printers for NativeAOT managed types (String, __Array<T>, Object).
        const pyPath = path.join(this.extensionPath, 'resources', 'gdb', 'cosmos_prettyprint.py');
        if (gdbHasPython && fs.existsSync(pyPath)) {
            setupCommands.push(`interpreter-exec console "source ${pyPath}"`);
        }

        this.spawnGdbAdapter();

        // Respond to launch and proxy the rest of the protocol. From now on
        // every DAP message that isn't disconnect/terminate is forwarded to
        // the gdb adapter. To kick off, we send our own `initialize` and
        // `attach` requests on behalf of VS Code.
        const adapterInitialize = {
            seq: 1,
            type: 'request',
            command: 'initialize',
            arguments: req.arguments?.__clientCaps || {
                clientID: 'cosmos-debug',
                adapterID: 'cosmos-gdb',
                linesStartAt1: true,
                columnsStartAt1: true,
                pathFormat: 'path'
            }
        };
        this.forwardToGdbRaw(adapterInitialize);

        const attach = {
            seq: 2,
            type: 'request',
            command: 'attach',
            arguments: {
                cwd: projectDir,
                target: `localhost:${gdbPort}`,
                gdbpath: gdbPath,
                executable: elfPath,
                setupCommands,
                autorun: []
            }
        };
        this.forwardToGdbRaw(attach);

        // Tell VS Code that launch succeeded. The user-visible session is
        // now backed by the gdb adapter via this proxy.
        this.respond(req, undefined);
        this.fireInitialized();
    }

    private async resolveProjectInfo(args: KernelDebugLaunchArgs): Promise<{ csproj: string; projectDir: string; name: string; arch: string } | null> {
        if (args.projectDir && args.kernelName) {
            const csprojCandidate = path.join(args.projectDir, `${args.kernelName}.csproj`);
            if (fs.existsSync(csprojCandidate)) {
                return {
                    csproj: csprojCandidate,
                    projectDir: args.projectDir,
                    name: args.kernelName,
                    arch: args.arch || 'x64'
                };
            }
        }
        // Fall back to the workspace's primary Cosmos project.
        const { getProjectInfo } = await import('../utils/project');
        const info = getProjectInfo();
        if (!info) {
            return null;
        }
        return {
            csproj: info.csproj,
            projectDir: path.dirname(info.csproj),
            name: info.name,
            arch: info.arch
        };
    }

    private spawnGdbAdapter(): void {
        const adapterPath = path.join(this.extensionPath, 'out', 'debug', 'cosmosGdbSession.js');
        const env: { [k: string]: string } = {};
        const srcEnv = getEnvWithDotnetTools();
        for (const k of Object.keys(srcEnv)) {
            const v = srcEnv[k];
            if (v !== undefined) {
                env[k] = v;
            }
        }
        env.ELECTRON_RUN_AS_NODE = '1';

        this.gdbProc = spawn(process.execPath, [adapterPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env
        });
        this.gdbProc.stdout!.on('data', d => this.onGdbData(d));
        this.gdbProc.stderr!.on('data', d => this.outputChannel.append(`[gdb-adapter] ${d}`));
        this.gdbProc.on('exit', code => {
            this.outputChannel.appendLine(`[gdb-adapter] exited code ${code}`);
            this.gdbProc = undefined;
            this.fireTerminated();
        });
    }

    private onGdbData(chunk: Buffer): void {
        this.gdbBuffer = Buffer.concat([this.gdbBuffer, chunk]);
        while (true) {
            const headerEnd = this.gdbBuffer.indexOf(GDB_DAP_FRAME_END);
            if (headerEnd === -1) {
                return;
            }
            const headerStr = this.gdbBuffer.slice(0, headerEnd).toString('ascii');
            const m = headerStr.match(/Content-Length:\s*(\d+)/i);
            if (!m) {
                this.gdbBuffer = this.gdbBuffer.slice(headerEnd + 4);
                continue;
            }
            const len = parseInt(m[1], 10);
            const bodyStart = headerEnd + 4;
            if (this.gdbBuffer.length < bodyStart + len) {
                return;
            }
            const body = this.gdbBuffer.slice(bodyStart, bodyStart + len).toString('utf8');
            this.gdbBuffer = this.gdbBuffer.slice(bodyStart + len);
            try {
                const msg = JSON.parse(body);
                this.onGdbMessage(msg);
            } catch (e) {
                this.outputChannel.appendLine(`[gdb-adapter] bad DAP frame: ${e}`);
            }
        }
    }

    private onGdbMessage(msg: any): void {
        // Swallow responses to the synthetic initialize/attach we sent
        // (seqs 1 and 2). The initialize-event handling is done by us
        // already, and we don't want to leak it to VS Code.
        if (msg.type === 'response' && msg.command === 'initialize' && msg.request_seq <= 2) {
            return;
        }
        if (msg.type === 'response' && msg.command === 'attach' && msg.request_seq <= 2) {
            return;
        }
        // The gdb adapter sends an `initialized` event after attach; we
        // already sent our own to VS Code right after launch, so suppress this
        // one to avoid duplicate configurationDone requests reaching gdb.
        if (msg.type === 'event' && msg.event === 'initialized') {
            return;
        }
        this._sendMessage.fire(msg);
    }

    private forwardToGdb(message: vscode.DebugProtocolMessage): void {
        this.forwardToGdbRaw(message);
    }

    private forwardToGdbRaw(message: any): void {
        if (!this.gdbProc || !this.gdbProc.stdin) {
            return;
        }
        const body = JSON.stringify(message);
        this.gdbProc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }

    private handleDisconnect(req: any): void {
        this.shutdown(req.command);
        this.respond(req, undefined);
    }

    private shutdown(reason: string): void {
        if (this.terminated) {
            return;
        }
        this.terminated = true;
        this.outputChannel.appendLine(`[cosmos-debug] shutdown (${reason})`);

        if (this.gdbProc && !this.gdbProc.killed) {
            try { this.gdbProc.kill(); } catch { /* already gone */ }
        }
        const cosmos = this.cosmosProc;
        if (cosmos && !cosmos.killed && cosmos.exitCode === null) {
            try {
                if (process.platform === 'win32' || !cosmos.pid) {
                    cosmos.kill();
                } else {
                    // SIGTERM the whole process group so QEMU dies with cosmos.
                    process.kill(-cosmos.pid, 'SIGTERM');
                }
            } catch {
                // already gone
            }
        }
    }

    private waitForPort(port: number, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        const poll = async (): Promise<void> => {
            while (Date.now() < deadline) {
                if (await isPortInUse(port)) {
                    return;
                }
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error(`QEMU gdbstub on port ${port} did not come up within ${timeoutMs}ms`);
        };
        return poll();
    }

    private respond(request: any, body: any): void {
        this._sendMessage.fire({
            type: 'response',
            request_seq: request.seq,
            success: true,
            command: request.command,
            body
        } as any);
    }

    private sendErrorResponse(request: any, message: string): void {
        this._sendMessage.fire({
            type: 'response',
            request_seq: request.seq,
            success: false,
            command: request.command,
            message
        } as any);
    }

    private fireInitialized(): void {
        this._sendMessage.fire({ type: 'event', event: 'initialized', seq: 0 } as any);
    }

    private fireTerminated(): void {
        if (this.terminated) {
            return;
        }
        this._sendMessage.fire({ type: 'event', event: 'terminated', seq: 0 } as any);
    }
}

export class KernelDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(
        private readonly extensionPath: string,
        private readonly outputChannel: vscode.OutputChannel
    ) { }

    createDebugAdapterDescriptor(
        _session: vscode.DebugSession,
        _executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
            new KernelDebugAdapter(this.extensionPath, this.outputChannel)
        );
    }
}
