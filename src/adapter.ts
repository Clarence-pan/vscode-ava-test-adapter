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
import * as util from 'util';
import * as path from 'path';
import { AvaTests } from './ava-tests';

/**
 * This class is intended as a starting point for implementing a "real" TestAdapter.
 * The file `README.md` contains further instructions.
 */
export class AvaTestAdapter implements TestAdapter {
  private disposables: { dispose(): void }[] = [];
  private isLoadingAllTests?: boolean;
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
      this.load.bind(this),
      this.testsEmitter,
      this.testStatesEmitter,
    );

    const initAvaTests = () => {
      this.avaTests.cwd =
        this.configSection.get('workingDirectory') || this.workspace.uri.fsPath;

      this.avaTests.avaExecutable =
        this.configSection.get('avaExecutable') || './node_modules/.bin/ava';

      this.avaTests.avaExecArgs = this.configSection.get('avaExecArgs') || [
        '--tap',
      ];

      this.avaTests.avaConfigFile =
        this.configSection.get('avaConfigFile') || './ava.config.js';

      this.avaTests.useShell = this.configSection.get('useShell') ?? false;

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

  async load(): Promise<void> {
    if (this.isLoadingAllTests) {
      this.log.warn('Already be loading AVA tests');
      return;
    }

    try {
      this.isLoadingAllTests = true;
      this.log.info('Loading AVA tests');

      this.retireEmitter.fire(<RetireEvent>{});

      this.testsEmitter.fire(<TestLoadStartedEvent>{ type: 'started' });

      const loadedTests = await this.avaTests.loadTests();

      this.log.info('AVA tests are loaded.');

      // prettier-ignore
      this.log.info('Loaded AVA tests:', util.inspect({
          rootSuite: loadedTests.rootSuite,
          testEvents: loadedTests.testEvents,
        }, false, 15, false));

      this.testsEmitter.fire(<TestLoadFinishedEvent>{
        type: 'finished',
        suite: loadedTests.rootSuite,
      });

      setTimeout(() => {
        if (loadedTests.testEvents) {
          loadedTests.testEvents.forEach((event) => {
            this.testStatesEmitter.fire(event);
          });
        }
      }, 50);
    } catch (err) {
      this.log.error('Failed to load AVA tests.');
      this.log.error('Error detail:', err);
      this.testsEmitter.fire(<TestLoadFinishedEvent>{
        type: 'finished',
        suite: undefined,
        errorMessage: `${err}`,
      });
    } finally {
      this.isLoadingAllTests = false;
    }
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
