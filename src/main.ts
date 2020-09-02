import * as vscode from 'vscode';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { Log, TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { AvaTestAdapter } from './adapter';

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = (vscode.workspace.workspaceFolders || [])[0];

  // create a simple logger that can be configured with the configuration variables
  // `avaTestExplorer.logpanel` and `avaTestExplorer.logfile`
  const log = new Log(
    'avaTestExplorer',
    workspaceFolder,
    'AVA Test Explorer Log',
  );

  context.subscriptions.push(log);

  // get the Test Explorer extension
  const testExplorerExtension = vscode.extensions.getExtension<TestHub>(
    testExplorerExtensionId,
  );

  if (log.enabled)
    log.info(`Test Explorer ${testExplorerExtension ? '' : 'not '}found`);

  if (testExplorerExtension) {
    const testHub = testExplorerExtension.exports;

    // this will register an ExampleTestAdapter for each WorkspaceFolder
    context.subscriptions.push(
      new TestAdapterRegistrar(
        testHub,
        (workspaceFolder) =>
          new AvaTestAdapter(
            workspaceFolder,
            vscode.workspace.getConfiguration('avaTestExplorer'),
            log,
          ),
        log,
      ),
    );
  }
}
