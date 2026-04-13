import * as vscode from 'vscode';
import { ProjectTreeProvider } from './providers/projectTree';
import { ToolsTreeProvider } from './providers/toolsTree';
import { LoadingViewProvider } from './providers/loadingView';
import { updateCosmosProjectContext, isCosmosProject } from './utils/project';
import { newProjectCommand } from './commands/newProject';
import { checkToolsCommand, installToolsCommand } from './commands/tools';
import { buildCommand } from './commands/build';
import { runCommand } from './commands/run';
import { debugCommand, onDebugSessionTerminated } from './commands/debug';
import { cleanCommand } from './commands/clean';
import { showProjectProperties } from './ui/propertiesWebview';
import { RunDebugAdapterFactory } from './utils/runAdapter';
import { CosmosDebugConfigurationProvider, CosmosDebugAdapterFactory, ensureLaunchJson } from './providers/debugConfigProvider';

let projectTreeProvider: ProjectTreeProvider;
let toolsTreeProvider: ToolsTreeProvider;
let loadingViewProvider: LoadingViewProvider;
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
    // "Cosmos: Debug Kernel" appears in Run and Debug dropdown
    const debugConfigProvider = new CosmosDebugConfigurationProvider();
    const debugAdapterFactory = new CosmosDebugAdapterFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('cosmos-debug', debugConfigProvider),
        vscode.debug.registerDebugConfigurationProvider('cosmos-debug', debugConfigProvider,
            vscode.DebugConfigurationProviderTriggerKind.Dynamic),
        vscode.debug.registerDebugAdapterDescriptorFactory('cosmos-debug', debugAdapterFactory)
    );

    // Register tree views
    vscode.window.registerTreeDataProvider('cosmos.project', projectTreeProvider);
    vscode.window.registerTreeDataProvider('cosmos.tools', toolsTreeProvider);

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

    // Register debug session termination listener
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(onDebugSessionTerminated));

    if (isCosmos) {
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
