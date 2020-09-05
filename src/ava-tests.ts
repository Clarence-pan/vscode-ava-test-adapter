import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { glob } from 'glob';
import _ from 'lodash';
import globToRegExp from 'glob-to-regexp';
import * as path from 'path';
import * as fs from 'fs';
import TapParser from 'tap-parser';
import * as util from 'util';
import * as vscode from 'vscode';
import {
  TestDecoration,
  TestEvent,
  TestInfo,
  TestLoadFinishedEvent,
  TestLoadStartedEvent,
  TestRunFinishedEvent,
  TestRunStartedEvent,
  TestSuiteEvent,
  TestSuiteInfo,
} from 'vscode-test-adapter-api';

const ROOT = 'root';
const TEST_NAME_SEP = ' › ';
const DEFAULT_FILES = ['test/**/*.{test,spec}.{js,jsx,ts,tsx}'];

const globAsync = util.promisify(glob);

export interface ILogger {
  debug(fmt: string, ...args: any[]): void;
  info(fmt: string, ...args: any[]): void;
  warn(fmt: string, ...args: any[]): void;
  error(fmt: string, ...args: any[]): void;
}

type AvaExecutionResult = {
  rootSuite: TestSuiteInfo;
  testEvents?: TestEvent[] | undefined;
  tapResults?: TapParserResults | undefined;
  stdout: string;
};

export class AvaTests {
  protected latestTestSuite: TestSuiteInfo = {
    type: 'suite',
    id: ROOT,
    label: 'All Suite', // the label of the root node should be the name of the testing framework
    children: [],
  };
  protected avaConfig!: { files: string[] | undefined };
  protected avaTestFiles: string[] = [];

  public constructor(
    protected readonly log: ILogger,
    protected readonly onReload: () => Promise<void>,
    protected readonly testsEmitter: vscode.EventEmitter<
      TestLoadStartedEvent | TestLoadFinishedEvent
    >,
    protected readonly testStatesEmitter: vscode.EventEmitter<
      TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
    >,
    public cwd: string = '.',
    public avaExecutable: string = './node_modules/.bin/ava',
    public avaExecArgs: string[] = ['--tap'],
    public avaConfigFile: string = './ava.config.js',
    public useShell: boolean = false,
  ) {}

  public init() {
    this.avaConfig = this.tryLoadAvaConfig();
  }

  public dispose() {}

  public async loadTests(): Promise<{
    rootSuite: TestSuiteInfo;
    testEvents?: TestEvent[];
  }> {
    this.log.debug(`Load AVA tests in ${this.cwd}`);

    await this.refreshTestFiles();

    const testSuiteInfo = await this.runAva({
      onStart: (_process, tapParser: ITapParser) => {
        tapParser.on('assert', (assert) => {
          this.testStatesEmitter.fire(parseTapAssertIntoTestEvent(assert));
        });
      },
    });

    Object.assign(this.latestTestSuite, testSuiteInfo.rootSuite);

    return testSuiteInfo;
  }

  public async runTests(tests: string[]): Promise<void> {
    await this.refreshTestFiles();

    for (const suiteOrTestId of tests) {
      const node = this.findNode(this.latestTestSuite, suiteOrTestId);
      if (node) {
        try {
          this.log.debug(`Run ${node.type} "${node.id}" ...`);
          await this.runNode(node);
          this.log.debug(`Run ${node.type} "${node.id}" ... [DONE]`);
        } catch (err) {
          this.log.debug(`Run ${node.type} "${node.id}" ... [FAIL]`, err);
        }
      } else {
        this.log.warn(`Cannot find "${suiteOrTestId}"!`);
      }
    }
  }

  public mapTestIdsToCmdLineFilters(testIds: string[]): string[] {
    const files: string[] = [];
    const testNames: string[] = [];

    testIds.forEach((testId) => {
      const { testFiles, testName } = this.parseTestId(testId);
      if (testFiles) {
        files.push(...testFiles);
      }

      if (testName) {
        testNames.push(testName);
      }
    });

    return [
      ..._.uniq(files),
      ..._.uniq(testNames).flatMap((name) => ['--match', name]),
    ];
  }

  private findNode(
    searchNode: TestSuiteInfo | TestInfo,
    id: string,
  ): TestSuiteInfo | TestInfo | undefined {
    if (searchNode.id === id) {
      return searchNode;
    } else if (searchNode.type === 'suite') {
      for (const child of searchNode.children) {
        const found = this.findNode(child, id);
        if (found) return found;
      }
    }
    return undefined;
  }

  private async runNode(node: TestSuiteInfo | TestInfo): Promise<void> {
    if (node.type === 'suite') {
      await this.runTestSuite(node);
    } else {
      // node.type === 'test'
      await this.runTestCase(node);
    }
  }

  private async runTestSuite(node: TestSuiteInfo) {
    this.testStatesEmitter.fire(<TestSuiteEvent>{
      type: 'suite',
      suite: node.id,
      state: 'running',
    });

    try {
      if (node.id === ROOT) {
        await this.onReload();
      } else {
        for (const child of node.children) {
          await this.runNode(child);
        }
      }
    } catch (e) {
      this.log.warn(`Failed to run suite "${node.id}".`, e);
    } finally {
      this.testStatesEmitter.fire(<TestSuiteEvent>{
        type: 'suite',
        suite: node.id,
        state: 'completed',
      });
    }
  }

  private async runTestCase(node: TestInfo) {
    try {
      this.testStatesEmitter.fire(<TestEvent>{
        type: 'test',
        test: node.id,
        state: 'running',
      });

      const { testFiles, testName } = await this.parseTestId(node.id);
      if (testFiles.length <= 0) {
        throw new Error(`Cannot find test files by name "${node.id}"`);
      }

      let hasFiredResult = false;

      const result = await this.runAva({
        execArgs: [...testFiles, ...(testName ? ['--match', testName] : [])],
        onStart: (_process, tapParser: ITapParser) => {
          tapParser.on('assert', (assert) => {
            if (assert.name === node.id) {
              this.testStatesEmitter.fire(parseTapAssertIntoTestEvent(assert));
              hasFiredResult = true;
            } else {
              this.log.warn('Matched another test: ', assert);
              this.testStatesEmitter.fire(parseTapAssertIntoTestEvent(assert));
            }
          });
        },
      });

      if (!hasFiredResult) {
        this.testStatesEmitter.fire(
          this.createDefaultTestEventForSingleTestCase(node, result),
        );
      }
    } catch (e) {
      this.log.warn(`Failed to run test "${node.id}"`, e);
      this.testStatesEmitter.fire(this.createTestEventOnError(node, e));
    }
  }

  private parseTestId(
    testId: string,
  ): { testFiles: string[]; testName?: string } {
    const testIdFragments = testId.split(TEST_NAME_SEP);
    if (!testIdFragments.some((fragment) => /\.\w+$/.test(fragment))) {
      const testPathPattern = '**/' + testIdFragments.join(path.sep) + '/**/*';
      const testPathRegExp = globToRegExp(testPathPattern);
      return {
        testFiles: this.avaTestFiles.filter((file) =>
          testPathRegExp.test(file),
        ),
      };
    }

    const testPath = testIdFragments.slice(0, testIdFragments.length - 1);
    const testName = testIdFragments[testIdFragments.length - 1];

    const testPathPattern =
      '**/' + testPath.join(path.sep).replace(/\.\w+$/, '*');
    const testPathRegExp = globToRegExp(testPathPattern);
    const testFiles = this.avaTestFiles.filter((file) =>
      testPathRegExp.test(file),
    );

    return {
      testFiles,
      testName,
    };
  }

  private async parseTestIdToFile(testId: string): Promise<string | undefined> {
    const firstFile = (await this.parseTestId(testId)).testFiles[0];

    if (firstFile) {
      return path.resolve(this.cwd, firstFile);
    }

    return undefined;
  }

  private async runAva({
    cwd = this.cwd,
    execCmd = this.avaExecutable,
    execArgs = [],
    env,
    onStart,
  }: {
    cwd?: string;
    execCmd?: string;
    execArgs?: string[];
    env?: Record<string, string>;
    onStart?: (
      process: ChildProcessWithoutNullStreams,
      tapParser: ITapParser,
    ) => void;
  } = {}): Promise<AvaExecutionResult> {
    return new Promise((resolve, reject) => {
      const actualArgs = [...this.avaExecArgs, ...execArgs];

      this.log.debug(
        'EXECUTE ',
        execCmd,
        actualArgs
          .map((arg) => (/\s+/.test(arg) ? `'${arg}'` : `${arg}`))
          .join(' '),
        { cwd },
      );

      const tapProcess = spawn(execCmd, actualArgs, {
        stdio: 'pipe',
        cwd,
        env,
        shell: this.useShell,
      });

      const stdoutChunks: string[] = [];

      let hasGotResults = false;

      const tapParser = new TapParser(
        { passes: true },
        async (results: any) => {
          hasGotResults = true;

          this.log.debug(
            'got results: ',
            util.inspect(results, false, 10, false),
          );

          try {
            const testSuiteInfo = await convertTapParserResultsToTestSuiteInfo(
              results,
              {
                parseTestIdToFile: async (testId: string) =>
                  this.parseTestIdToFile(testId),
              },
            );

            resolve({
              ...testSuiteInfo,
              tapResults: results,
              stdout: stdoutChunks.join(''),
            });
          } catch (err) {
            reject(err);
          }
        },
      );

      tapProcess.stdout.pipe(tapParser);

      tapProcess.stdout.on('data', (chunk) => {
        stdoutChunks.push(chunk);

        `${chunk}`.split('\n').forEach((line) => {
          this.log.debug('[STDOUT]', line);
        });
      });

      tapProcess.stderr.on('data', (chunk) => {
        `${chunk}`.split('\n').forEach((line) => {
          this.log.debug('[STDERR]', line);
        });
      });

      tapProcess.on('error', (err) => {
        this.log.debug('ava process failed: ', err);
        setTimeout(() => {
          if (!hasGotResults) {
            this.log.info('failed to load tests:', err);
            reject(new Error(`${err}`));
          }
        }, 1000);
      });

      if (onStart) {
        onStart(tapProcess, tapParser);
      }
    });
  }

  private async refreshTestFiles() {
    this.avaTestFiles = (
      await Promise.all(
        (this.avaConfig.files || DEFAULT_FILES).map((pattern) =>
          globAsync(pattern, { cwd: this.cwd }),
        ),
      )
    ).reduce((acc, value) => [...acc, ...value], []);
  }

  private tryLoadAvaConfig() {
    try {
      const cfgFilePath = path.resolve(this.cwd, this.avaConfigFile);
      const cfgFileContent = fs.readFileSync(cfgFilePath, 'utf8');

      // TODO: 还有没有更好的方法？
      const config = /export default/.test(cfgFileContent)
        ? new Function(
            `${cfgFileContent.replace(/export default/, 'return ')}`,
          ).call(undefined)
        : require(cfgFilePath);

      if (typeof config === 'object' && config) {
        return config;
      } else {
        this.log.warn(`Invalid AVA config file: ${this.avaConfigFile}`);
      }
    } catch (e) {
      this.log.warn(
        `Failed to load config file: ${this.avaConfigFile} cwd=${this.cwd}`,
        e,
      );
    }

    return {
      files: DEFAULT_FILES,
    };
  }

  private createDefaultTestEventForSingleTestCase(
    test: TestInfo,
    result: AvaExecutionResult,
  ): TestEvent {
    const event: TestEvent = {
      type: 'test',
      test: test.id,
      state: 'passed',
    };

    /*
      FinalResults {
        ok: false,
        count: 1,
        pass: 0,
        fail: 2,
        bailout: false,
        todo: 0,
        skip: 1,
        plan: FinalPlan {
          start: 1,
          end: 0,
          skipAll: true,
          skipReason: '',
          comment: ''
        },
        failures: [
          Result {
            ok: false,
            id: 1,
            name: 'Exited because no new tests completed within the last 10000ms of inactivity',
            fullname: ''
          },
          { tapError: 'Plan of 1..0, but test points encountered' }
        ],
        time: null,
        passes: []
      }*/
    if (result.tapResults?.plan?.skipAll) {
      event.state = 'errored';
      event.message =
        '# This test case is skipped for internal error or other reason. Please open the output "AVA Test Explorer Log" for more detail. ' +
        (result.tapResults?.failures?.find(isTapError)?.tapError || '') +
        '\n' +
        result.stdout;
    }

    if (result.tapResults?.fail) {
      event.state = 'failed';
      event.message = [
        '# This test case is failed. ',
        '# The below is stdout of AVA. For more detail, please open the output "AVA Test Explorer Log".',
        result.stdout,
      ].join('\n');
    }

    if (event.message) {
      const firstDiag = result.tapResults?.failures?.[0];
      if (isTapDiag(firstDiag)) {
        event.decorations = getDiagAtFileLine(firstDiag, event.message);
      }
    }

    return event;
  }

  private createTestEventOnError(node: TestInfo, error: any): TestEvent {
    return <TestEvent>{
      type: 'test',
      test: node.id,
      state: 'errored',
      message: this.getErrorMessage(error),
    };
  }

  private getErrorMessage(error: any) {
    return `${error}`;
  }
}

type TapError = {
  tapError: string;
};

export type TapParserResults = {
  count: number;
  ok: boolean;
  pass: number;
  fail: number;
  skip: number;
  todo: number;
  time: null;
  plan: {
    start: number;
    end: number;
    skipAll: boolean;
    skipReason: string;
  };
  passes?: Array<ITapAsset>;
  failures?: Array<ITapAsset | TapError>;
};

function getTestState(
  assert: ITapAsset,
): 'running' | 'passed' | 'failed' | 'skipped' | 'errored' {
  return assert.skip || assert.todo
    ? 'skipped'
    : assert.ok
    ? 'passed'
    : 'failed';
}

export async function convertTapParserResultsToTestSuiteInfo(
  results: TapParserResults,
  {
    parseTestIdToFile,
  }: {
    parseTestIdToFile?: (testId: string) => Promise<string | undefined>;
  } = {},
): Promise<{
  rootSuite: TestSuiteInfo;
  testEvents?: TestEvent[];
}> {
  const root: TestSuiteInfo = {
    type: 'suite',
    id: ROOT,
    label: 'AVA Tests',
    children: [],
  };

  const suites = new Map<string, TestSuiteInfo>();
  const tests = new Map<string, TestInfo>();
  const testEvents: TestEvent[] = [];

  const addTest = (suitePath: string[], test: TestInfo | TestSuiteInfo) => {
    if (test.type === 'test') {
      tests.set(test.id, test);
    }

    if (suitePath.length === 0) {
      root.children.push(test);
      return;
    }

    const suitePathId = suitePath.join(TEST_NAME_SEP);
    const targetSuite = suites.get(suitePathId);
    if (targetSuite) {
      targetSuite.children.push(test);
      return;
    }

    const newSuite: TestSuiteInfo = {
      type: 'suite',
      id: suitePathId,
      label: suitePath[suitePath.length - 1],
      children: [test],
    };

    suites.set(suitePathId, newSuite);

    addTest(suitePath.slice(0, suitePath.length - 1), newSuite);
  };

  [...(results.passes || []), ...(results.failures || [])]
    .filter(isITapAsset)
    .filter((assert) => `${assert.name}`.indexOf(TEST_NAME_SEP) >= 0)
    .forEach((assert) => {
      const namePath = assert.name
        .split(TEST_NAME_SEP)
        .map((x) => x.trim())
        .filter((x) => x);

      const testId = assert.name;

      const testInfo: TestInfo = {
        type: 'test',
        id: testId,
        label: namePath[namePath.length - 1] || 'Unnamed Test',
      };

      addTest(namePath.slice(0, namePath.length - 1), testInfo);

      testEvents.push(parseTapAssertIntoTestEvent(assert));
    });

  if (parseTestIdToFile) {
    await Promise.all([
      ...Array.from(tests.values()).map(async (test) => {
        test.file = await parseTestIdToFile(test.id);
      }),
      ...Array.from(suites.values()).map(async (suite) => {
        const firstTestFileInTheSuite = await parseTestIdToFile(
          suite.id + TEST_NAME_SEP + '*',
        );

        if (firstTestFileInTheSuite) {
          suite.file = /\.\w+$/.test(suite.id)
            ? firstTestFileInTheSuite
            : path.dirname(firstTestFileInTheSuite);
        }
      }),
    ]);
  }

  return {
    rootSuite: root,
    testEvents,
  };
}

export function parseTapAssertIntoTestEvent(assert: ITapAsset): TestEvent {
  const event: TestEvent = {
    type: 'test',
    test: assert.name,
    state: getTestState(assert),
  };

  if (assert.diag) {
    try {
      event.message = TapParser.stringify([['assert', assert]]) as string;
    } catch (e) {
      //ignore
    }

    event.decorations = getDiagAtFileLine(assert.diag, event.message);
  }

  return event;
}

export interface ITapParser {
  on(event: string, callback: (asset: ITapAsset) => void): void;
}
export interface ITapAsset {
  ok: boolean;
  id: number;
  name: string;
  todo?: boolean;
  skip?: boolean;
  diag?: ITapDiagInfo;
}

export interface ITapDiagInfo {
  assertion: string;
  at: string;
  name: string;
  values?: Record<string, string>;
}

function isTapError(x: any): x is TapError {
  return typeof x === 'object' && x !== null && typeof x.tapError === 'string';
}

function isTapDiag(x: any): x is ITapDiagInfo {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof x.name === 'string' &&
    typeof x.assertion === 'string'
  );
}

function isITapAsset(x: any): x is ITapAsset {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof x.name === 'string' &&
    typeof x.id === 'number'
  );
}

function getDiagAtFileLine(
  diag: ITapDiagInfo,
  summaryMessage: string | undefined,
): TestDecoration[] | undefined {
  const m = `${diag.at}`.match(/\((.+?):(\d+):(\d+)\)/);

  if (m) {
    return [
      {
        line: Number(m[2]),
        message: summaryMessage
          ? `${summaryMessage}`
              .split('\n')
              .filter((line) => !/^not ok|^  ---$/i.test(line))
              .join('↩')
          : `${diag.name || ''} "${diag.assertion || 'unknown'}"`,
        hover: summaryMessage,
      },
    ];
  }

  return undefined;
}
