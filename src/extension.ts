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
import { showMemoryRegions, onDebugSessionEnded, onDebugSessionStarted } from './ui/memoryWebview';
import { RunDebugAdapterFactory } from './utils/runAdapter';

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
        vscode.commands.registerCommand('cosmos.projectProperties', () => showProjectProperties(context, projectTreeProvider)),
        vscode.commands.registerCommand('cosmos.memoryRegions', () => showMemoryRegions(context))
    );

    // Register debug session listeners
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(session => {
            // Only track Cosmos debug sessions (cppdbg with our naming convention)
            if (session.type === 'cppdbg' && session.name.startsWith('Debug ')) {
                vscode.commands.executeCommand('setContext', 'cosmos:debugging', true);
                // Show Memory Regions entry in project tree
                projectTreeProvider.setDebugging(true);
                // Resume memory polling if panel is open
                onDebugSessionStarted();
            }
        }),
        vscode.debug.onDidTerminateDebugSession(session => {
            onDebugSessionTerminated(session);
            // Clear debugging context when session ends
            if (session.type === 'cppdbg' && session.name.startsWith('Debug ')) {
                vscode.commands.executeCommand('setContext', 'cosmos:debugging', false);
                // Hide Memory Regions entry from tree (but keep panel open if user opened it)
                projectTreeProvider.setDebugging(false);
                // Stop memory polling and update UI
                onDebugSessionEnded();
            }
        })
    );

    if (isCosmos) {
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
