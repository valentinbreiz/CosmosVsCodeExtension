import * as vscode from 'vscode';
import { ProjectTreeProvider } from './providers/projectTree';
import { ToolsTreeProvider } from './providers/toolsTree';
import { LoadingViewProvider } from './providers/loadingView';
import { updateCosmosProjectContext, isCosmosProject } from './utils/project';
import { newProjectCommand } from './commands/newProject';
import { checkToolsCommand, installToolsCommand } from './commands/tools';
import { buildCommand } from './commands/build';
import { runCommand } from './commands/run';
import { debugCommand } from './commands/debug';
import { cleanCommand } from './commands/clean';
import { showProjectProperties } from './ui/propertiesWebview';
import { RunDebugAdapterFactory } from './utils/runAdapter';
import { CosmosDebugConfigurationProvider, ensureLaunchJson } from './providers/debugConfigProvider';
import { CosmosTestController } from './testing/testController';
import { KernelDebugAdapterFactory } from './debug/kernelDebugAdapter';
import { KernelThreadsProvider, KernelThreadsTrackerFactory } from './views/kernelThreadsView';
import { KernelGCProvider, KernelGCTrackerFactory } from './views/kernelGCView';
import { KernelMemoryProvider, KernelMemoryTrackerFactory } from './views/kernelMemoryView';
import { KernelMemoryMapViewProvider } from './views/kernelMemoryMapView';
import { getOutputChannel } from './utils/output';

let projectTreeProvider: ProjectTreeProvider;
let toolsTreeProvider: ToolsTreeProvider;
let loadingViewProvider: LoadingViewProvider;
let testController: CosmosTestController | undefined;
export let runDebugAdapterFactory: RunDebugAdapterFactory;

export function activate(context: vscode.ExtensionContext) {
    // Check immediately if this is a Cosmos project
    const isCosmos = isCosmosProject();

    // Set cosmos project context early so loading view can show
    vscode.commands.executeCommand('setContext', 'cosmos:isCosmosProject', isCosmos);

    // Initialize tree providers
    projectTreeProvider = new ProjectTreeProvider();
    toolsTreeProvider = new ToolsTreeProvider();
    loadingViewProvider = new LoadingViewProvider(context.extensionUri);

    // Initialize run adapter factory (dummy process initially)
    runDebugAdapterFactory = new RunDebugAdapterFactory(undefined as any);
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('cosmos-run', runDebugAdapterFactory));

    // Register cosmos-debug adapter factory + configuration provider so
    // "Cosmos: Debug Kernel" appears in Run and Debug dropdown. The factory
    // creates an inline adapter that owns the cosmos process and proxies DAP
    // traffic to the external gdb-mi adapter, so a single Stop click takes
    // down the entire tree.
    const debugConfigProvider = new CosmosDebugConfigurationProvider();
    const debugAdapterFactory = new KernelDebugAdapterFactory(context.extensionPath, getOutputChannel());
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('cosmos-debug', debugConfigProvider),
        vscode.debug.registerDebugConfigurationProvider('cosmos-debug', debugConfigProvider,
            vscode.DebugConfigurationProviderTriggerKind.Dynamic),
        vscode.debug.registerDebugAdapterDescriptorFactory('cosmos-debug', debugAdapterFactory)
    );

    // When a Cosmos debug session ends, swing the sidebar back to the Cosmos
    // view so the user lands on the project tree instead of an idle Run and
    // Debug pane. Only triggers for our own debug types.
    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession(session => {
            if (session.type === 'cosmos-debug' || session.type === 'cosmos-run') {
                vscode.commands.executeCommand('workbench.view.extension.cosmos');
            }
        })
    );

    // Register tree views
    vscode.window.registerTreeDataProvider('cosmos.project', projectTreeProvider);
    vscode.window.registerTreeDataProvider('cosmos.tools', toolsTreeProvider);

    // Kernel introspection views — only meaningful during a cosmos-debug
    // session. Show "Start a debug session" placeholder when idle.
    const kernelThreadsProvider = new KernelThreadsProvider();
    kernelThreadsProvider.setMessage('Start a Cosmos debug session to inspect kernel threads.');
    vscode.window.registerTreeDataProvider('cosmos.kernelThreads', kernelThreadsProvider);
    const kernelGCProvider = new KernelGCProvider();
    kernelGCProvider.setMessage('Start a Cosmos debug session to inspect GC state.');
    vscode.window.registerTreeDataProvider('cosmos.kernelGC', kernelGCProvider);
    const kernelMemoryProvider = new KernelMemoryProvider();
    kernelMemoryProvider.setMessage('Start a Cosmos debug session to inspect memory manager state.');
    vscode.window.registerTreeDataProvider('cosmos.kernelMemory', kernelMemoryProvider);
    const kernelMemoryView = new KernelMemoryMapViewProvider(context.extensionUri, kernelMemoryProvider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(KernelMemoryMapViewProvider.viewType, kernelMemoryView)
    );
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('cosmos-debug', new KernelThreadsTrackerFactory(kernelThreadsProvider)),
        vscode.debug.registerDebugAdapterTrackerFactory('cosmos-debug', new KernelGCTrackerFactory(kernelGCProvider)),
        vscode.debug.registerDebugAdapterTrackerFactory('cosmos-debug', new KernelMemoryTrackerFactory(kernelMemoryProvider)),
        vscode.commands.registerCommand('cosmos.kernelThreads.copy', async () => {
            const text = kernelThreadsProvider.serialize();
            await vscode.env.clipboard.writeText(text);
            vscode.window.setStatusBarMessage('Kernel Threads copied to clipboard', 2000);
        }),
        vscode.commands.registerCommand('cosmos.kernelThreads.refresh', () => {
            const session = vscode.debug.activeDebugSession;
            if (session && session.type === 'cosmos-debug') {
                kernelThreadsProvider.refresh(session);
            }
        }),
        vscode.commands.registerCommand('cosmos.kernelGC.copy', async () => {
            const text = kernelGCProvider.serialize();
            await vscode.env.clipboard.writeText(text);
            vscode.window.setStatusBarMessage('Kernel GC copied to clipboard', 2000);
        }),
        vscode.commands.registerCommand('cosmos.kernelGC.refresh', () => {
            void kernelGCProvider.refresh();
        }),
        vscode.commands.registerCommand('cosmos.kernelMemory.copy', async () => {
            const text = kernelMemoryProvider.serialize();
            await vscode.env.clipboard.writeText(text);
            vscode.window.setStatusBarMessage('Kernel Memory copied to clipboard', 2000);
        }),
        vscode.commands.registerCommand('cosmos.kernelMemory.refresh', () => {
            void kernelMemoryProvider.refresh();
        })
    );

    // Register loading view provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(LoadingViewProvider.viewType, loadingViewProvider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('cosmos.newProject', () => newProjectCommand(context, projectTreeProvider, toolsTreeProvider)),
        vscode.commands.registerCommand('cosmos.checkTools', () => checkToolsCommand(toolsTreeProvider)),
        vscode.commands.registerCommand('cosmos.installTools', installToolsCommand),
        vscode.commands.registerCommand('cosmos.build', buildCommand),
        vscode.commands.registerCommand('cosmos.run', runCommand),
        vscode.commands.registerCommand('cosmos.debug', debugCommand),
        vscode.commands.registerCommand('cosmos.clean', cleanCommand),
        vscode.commands.registerCommand('cosmos.refreshTools', () => toolsTreeProvider.refresh()),
        vscode.commands.registerCommand('cosmos.projectProperties', () => showProjectProperties(context, projectTreeProvider))
    );

    if (isCosmos) {
        testController = new CosmosTestController();
        context.subscriptions.push(testController);

        // Ensure .vscode/launch.json has the Cosmos debug config so the
        // Run and Debug panel shows "Cosmos: Debug Kernel" immediately
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (wsFolder) {
            ensureLaunchJson(wsFolder);
        }

        // Cosmos project: show loading gif, then switch to project settings after delay
        setTimeout(() => {
            vscode.commands.executeCommand('setContext', 'cosmos:initialized', true);
        }, 1500);
    } else {
        // No project: show welcome screen immediately (no loading)
        vscode.commands.executeCommand('setContext', 'cosmos:initialized', true);
    }

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
