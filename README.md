# AVA Test Adapter for Visual Studio Code For AVA3

## How to use?

Just install it and use as like all other test explorers.

1. Install the extension
2. Restart VS Code and open the Test view
3. Run / Debug your tests using Test Explorer

## Configuration Options

| Property                           | Description                                              | Default                   |
| ---------------------------------- | -------------------------------------------------------- | ------------------------- |
| `avaTestExplorer.workingDirectory` | The working directory for AVA relative to the workspace. | The workspace folder.     |
| `avaTestExplorer.avaExecutable`    | The executable AVA location                              | `./node_modules/.bin/ava` |
| `avaTestExplorer.avaExecArgs`      | The execution arguments for AVA                          | `[ '--tap']`              |
| `avaTestExplorer.avaConfigFile`    | the AVA configuration file location                      | `./ava.config.js`         |
| `avaTestExplorer.nodeArgv`         | The arguments to the Node executable                     |
| `avaTestExplorer.useShell`         | use shell to run commands (not recommended)              | `false`                   |
| `avaTestExplorer.logpanel`         | If `true` writes a diagnostic log to AVA Explorer Log    | `false`                   |
| `avaTestExplorer.logfile`          | A file to write diagnostics to                           | `undefined`               |
