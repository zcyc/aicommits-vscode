const assert = require('node:assert/strict');
const Module = require('node:module');

const repository = {
  rootUri: { fsPath: process.cwd() },
  inputBox: { value: '' }
};
const handlers = [];
const errors = [];
let commands = ["printf 'generated message\\n'"];
let output = 'stdout';
let repositories = [repository];
let clipboardReader = async () => '';
const vscode = {
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({
      get: (key, fallback) => key === 'command'
        ? commands.shift()
        : key === 'output' ? output : fallback
    })
  },
  extensions: {
    getExtension: () => ({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories,
          getRepository: uri => repositories.find(
            candidate => candidate.rootUri.fsPath === uri.fsPath
          )
        })
      }
    })
  },
  window: {
    withProgress: async (_options, callback) => callback(null, {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    }),
    showErrorMessage: async (...args) => { errors.push(args); }
  },
  ProgressLocation: { SourceControl: 1 },
  commands: {
    registerCommand: (_id, handler) => {
      handlers.push(handler);
      return { dispose() {} };
    }
  },
  env: { clipboard: { readText: () => clipboardReader() } }
};

const originalLoad = Module._load;
Module._load = (request, parent, isMain) => (
  request === 'vscode' ? vscode : originalLoad(request, parent, isMain)
);

try {
  require('../extension').activate({ subscriptions: [] });
  (async () => {
    await handlers[0]({ rootUri: { scheme: 'file', fsPath: process.cwd() } });
    assert.equal(repository.inputBox.value, 'generated message');
    console.log('stdout smoke test passed');

    commands = [
      "sleep 0.2; printf 'old\\n'",
      "sleep 0.01; printf 'new\\n'"
    ];
    const firstRun = handlers[0]();
    await new Promise(resolve => setImmediate(resolve));
    const secondRun = handlers[0]();
    await Promise.all([firstRun, secondRun]);
    assert.equal(repository.inputBox.value, 'new', 'latest invocation must win');
    console.log('concurrency regression test passed');

    commands = ["printf 'command not found' >/dev/null; exit 1"];
    await handlers[0]();
    const error = errors[errors.length - 1];
    assert.equal(error[1], undefined, 'failed commands must not be marked as missing');
    assert.match(error[0], /Command failed:/);
    console.log('command detection regression test passed');

    const repositoryB = {
      rootUri: { fsPath: '/private/tmp' },
      inputBox: { value: '' }
    };
    repositories = [repository, repositoryB];
    commands = [
      "sleep 0.2; printf 'repository A\\n'",
      "sleep 0.01; printf 'repository B\\n'"
    ];
    const firstRepositoryRun = handlers[0]({ scheme: 'file', fsPath: process.cwd() });
    await new Promise(resolve => setTimeout(resolve, 100));
    const secondRepositoryRun = handlers[0]({ scheme: 'file', fsPath: '/private/tmp' });
    await Promise.all([firstRepositoryRun, secondRepositoryRun]);
    assert.equal(repository.inputBox.value, 'repository A');
    assert.equal(repositoryB.inputBox.value, 'repository B');
    console.log('cross-repository regression test passed');

    repositories = [repository];
    output = 'clipboard';
    commands = ['printf done', 'printf done'];
    let releaseClipboard;
    let clipboardReads = 0;
    clipboardReader = async () => clipboardReads++ === 0
      ? new Promise(resolve => { releaseClipboard = resolve; })
      : 'repository B';
    const firstClipboardRun = handlers[0]();
    await new Promise(resolve => setTimeout(resolve, 100));
    const secondClipboardRun = handlers[0]();
    await new Promise(resolve => setTimeout(resolve, 100));
    releaseClipboard('');
    const errorCount = errors.length;
    await Promise.all([firstClipboardRun, secondClipboardRun]);
    assert.equal(errors.length, errorCount, 'superseded clipboard runs must not show errors');
    assert.equal(repository.inputBox.value, 'repository B');
    console.log('clipboard cancellation regression test passed');

    output = 'stdout';
    clipboardReader = async () => '';
    commands = ['/definitely/missing-aicommits-command'];
    const missingCommandErrorCount = errors.length;
    await handlers[0]();
    const missingCommandError = errors[missingCommandErrorCount];
    assert.equal(missingCommandError[1], 'Open Settings');
    console.log('missing command regression test passed');
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} finally {
  Module._load = originalLoad;
}
