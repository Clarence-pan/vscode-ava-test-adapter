import * as vscode from 'vscode';
import {
  TestAdapter,
  TestLoadStartedEvent,
  TestLoadFinishedEvent,
  TestRunStartedEvent,
  TestRunFinishedEvent,
  TestSuiteEvent,
  TestEvent,
  RetireEvent,
} from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';

import * as path from 'path';
import { AvaTests } from './ava-tests';

/**
 * This class is intended as a starting point for implementing a "real" TestAdapter.
 * The file `README.md` contains further instructions.
 */
export class AvaTestAdapter implements TestAdapter {
  private disposables: { dispose(): void }[] = [];
  private readonly testsEmitter = new vscode.EventEmitter<
    TestLoadStartedEvent | TestLoadFinishedEvent
  >();
  private readonly testStatesEmitter = new vscode.EventEmitter<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  >();
  private readonly retireEmitter = new vscode.EventEmitter<RetireEvent>();
  private readonly autorunEmitter = new vscode.EventEmitter<void>();
  private readonly avaTests: AvaTests;

  get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
    return this.testsEmitter.event;
  }

  get testStates(): vscode.Event<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  > {
    return this.testStatesEmitter.event;
  }

  get retire(): vscode.Event<RetireEvent> {
    return this.retireEmitter.event;
  }

  get autorun(): vscode.Event<void> | undefined {
    return this.autorunEmitter.event;
  }

  constructor(
    public readonly workspace: vscode.WorkspaceFolder,
    private readonly configSection: vscode.WorkspaceConfiguration,
    private readonly log: Log,
  ) {
    this.log.info('Initializing ava adapter');

    this.avaTests = new AvaTests(
      this.log,
      this.testsEmitter,
      this.testStatesEmitter,
    );

    const initAvaTests = () => {
      const options = this.getOptions();

      this.avaTests.cwd = options.workingDirectory;
      this.avaTests.avaExecutable = options.avaExecutable;
      this.avaTests.avaExecArgs = options.avaExecArgs;
      this.avaTests.avaConfigFile = options.avaConfigFile;
      this.avaTests.useShell = options.useShell;

      this.avaTests.init();
    };

    initAvaTests();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        initAvaTests();
      }),
    );

    this.disposables.push(this.testsEmitter);
    this.disposables.push(this.testStatesEmitter);
    this.disposables.push(this.autorunEmitter);
    this.disposables.push(this.avaTests);
  }

  getOptions() {
    return {
      autoDetectLernaWorkspaces: this.configSection.get(
        'autoDetectLernaWorkspaces',
      ) as boolean,
      workingDirectory:
        (this.configSection.get('workingDirectory') as string) ||
        this.workspace.uri.fsPath,
      avaExecutable:
        (this.configSection.get('avaExecutable') as string) ||
        './node_modules/.bin/ava',
      avaExecArgs: (this.configSection.get('avaExecArgs') as string[]) || [
        '--tap',
      ],
      avaConfigFile:
        (this.configSection.get('avaConfigFile') as string) ||
        './ava.config.js',
      useShell: this.configSection.get('useShell') as boolean,
    };
  }

  async load(): Promise<void> {
    this.avaTests.loadTests();
  }

  async run(tests: string[]): Promise<void> {
    this.log.info(`Running ava tests ${JSON.stringify(tests)}`);

    try {
      this.testStatesEmitter.fire(<TestRunStartedEvent>{
        type: 'started',
        tests,
      });

      // in a "real" TestAdapter this would start a test run in a child process
      await this.avaTests.runTests(tests);
    } finally {
      this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
    }
  }

  /* implement this method if your TestAdapter supports debugging tests*/
  async debug(tests: string[]): Promise<void> {
    // start a test run in a child process and attach the debugger to it...

    const testFilters = this.avaTests.mapTestIdsToCmdLineFilters(tests);
    const args = [
      ...this.avaTests.avaExecArgs.filter((x) => x !== '--tap' && x !== '-t'),
      ...testFilters,
    ];

    const debugConfiguration: vscode.DebugConfiguration = {
      console: true,
      cwd: this.avaTests.cwd,
      internalConsoleOptions: 'neverOpen',
      name: 'vscode-ava-test-adapter',
      request: 'launch',
      type: 'node',

      runtimeExecutable: path.resolve(
        this.avaTests.cwd,
        this.avaTests.avaExecutable,
      ),
      args,
    };

    await vscode.debug.startDebugging(this.workspace, debugConfiguration);
  }

  cancel(): void {
    // in a "real" TestAdapter this would kill the child process for the current test run (if there is any)
    this.avaTests.cancelAll();
  }

  dispose(): void {
    this.cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}
