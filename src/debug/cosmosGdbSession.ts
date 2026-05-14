// @ts-nocheck
// Cosmos-specific subclass of code-debug's MI2DebugSession. We only need the
// gdb-remote attach path (QEMU's gdbstub on localhost:1234), so the launch and
// SSH branches are not reachable. Everything heavy — MI parsing, breakpoint
// management, variables, stepping — comes from the vendored base class.
import { MI2DebugSession, RunCommand } from './codedebug/mibase';
import { DebugSession } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { MI2, escape } from './codedebug/backend/mi2/mi2';
import { ValuesFormattingMode } from './codedebug/backend/backend';

export interface CosmosAttachArguments extends DebugProtocol.AttachRequestArguments {
    cwd: string;
    target: string;          // "host:port" — passed straight to gdb's target remote
    gdbpath: string;
    executable: string;      // the kernel ELF (for symbols)
    setupCommands?: string[]; // run BEFORE target-select (e.g. "gdb-set osabi none")
    autorun?: string[];       // run AFTER target-select
    valuesFormatting?: ValuesFormattingMode;
    pathSubstitutions?: { [src: string]: string };
    showDevDebugOutput?: boolean;
    registerLimit?: string;
}

class CosmosGdbSession extends MI2DebugSession {
    public constructor() {
        super(false);
    }

    protected override initializeRequest(
        response: DebugProtocol.InitializeResponse,
        _args: DebugProtocol.InitializeRequestArguments
    ): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsFunctionBreakpoints = true;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsSetVariable = true;
        response.body.supportsLogPoints = true;
        this.sendResponse(response);
    }

    // We don't expose a launch mode — kernel debug always attaches to QEMU's
    // gdbstub. Map it to attach so accidental launch requests don't hang.
    protected override launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: any
    ): void {
        this.attachRequest(response as any, args);
    }

    protected override attachRequest(
        response: DebugProtocol.AttachResponse,
        args: CosmosAttachArguments
    ): void {
        const dbgCommand = args.gdbpath || 'gdb';
        if (!this.checkCommand(dbgCommand)) {
            this.sendErrorResponse(response, 104, `Configured debugger ${dbgCommand} not found.`);
            return;
        }

        this.miDebugger = new MI2(dbgCommand, ['-q', '--interpreter=mi2'], [], {});
        this.setPathSubstitutions(args.pathSubstitutions || {});
        // Pre-connect setup. These get folded into MI2.initCommands so they
        // execute before `target-select remote`. Required for gdb-set osabi
        // none on bare-metal targets — without it gdb issues qGetTIBAddr at
        // target-select time, which QEMU's gdbstub rejects.
        for (const cmd of args.setupCommands || []) {
            this.miDebugger.extraCommands.push(cmd);
        }
        this.initDebugger();
        this.quit = false;
        this.attached = false;
        this.initialRunCommand = RunCommand.CONTINUE;
        this.isSSH = false;
        this.started = false;
        this.crashed = false;
        this.setValuesFormattingMode(args.valuesFormatting || 'parseText');
        this.miDebugger.frameFilters = false;
        this.miDebugger.printCalls = false;
        this.miDebugger.debugOutput = !!args.showDevDebugOutput;
        this.stopAtEntry = false;
        this.miDebugger.registerLimit = args.registerLimit ?? '';

        this.miDebugger
            .connect(args.cwd, args.executable, args.target, args.autorun || [])
            .then(
                () => this.sendResponse(response),
                err => this.sendErrorResponse(response, 102, `Failed to attach: ${err.toString()}`)
            );
    }

    protected setPathSubstitutions(substitutions: { [src: string]: string }): void {
        for (const src of Object.keys(substitutions)) {
            this.miDebugger.extraCommands.push(
                `gdb-set substitute-path "${escape(src)}" "${escape(substitutions[src])}"`
            );
        }
    }
}

DebugSession.run(CosmosGdbSession);
