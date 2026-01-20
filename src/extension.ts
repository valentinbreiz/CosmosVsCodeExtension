import * as vscode from 'vscode';
import { ProjectTreeProvider } from './providers/projectTree';
import { ToolsTreeProvider } from './providers/toolsTree';
import { updateCosmosProjectContext } from './utils/project';
import { newProjectCommand } from './commands/newProject';
import { checkToolsCommand, installToolsCommand } from './commands/tools';
import { buildCommand } from './commands/build';
import { runCommand } from './commands/run';
import { debugCommand, onDebugSessionTerminated } from './commands/debug';
import { cleanCommand } from './commands/clean';
import { showProjectProperties } from './ui/propertiesWebview';
import { RunDebugAdapterFactory } from './utils/runAdapter';

let projectTreeProvider: ProjectTreeProvider;
let toolsTreeProvider: ToolsTreeProvider;
export let runDebugAdapterFactory: RunDebugAdapterFactory;

export function activate(context: vscode.ExtensionContext) {
    // Initialize tree providers
    projectTreeProvider = new ProjectTreeProvider();
    toolsTreeProvider = new ToolsTreeProvider();
    
    // Initialize run adapter factory (dummy process initially)
    runDebugAdapterFactory = new RunDebugAdapterFactory(undefined as any);
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('cosmos-run', runDebugAdapterFactory));

    // Register tree views
    vscode.window.registerTreeDataProvider('cosmos.project', projectTreeProvider);
    vscode.window.registerTreeDataProvider('cosmos.tools', toolsTreeProvider);

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

    // Check if this is a Cosmos project and update context
    updateCosmosProjectContext();

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