const assert = require('node:assert/strict');
const Module = require('node:module');

const repository = {
  rootUri: { fsPath: process.cwd() },
  inputBox: { value: '' }
};
const handlers = [];
const errors = [];
let commands = ["printf 'generated message\\n'"];
const vscode = {
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({
      get: (key, fallback) => key === 'command' ? commands.shift() : fallback
    })
  },
  extensions: {
    getExtension: () => ({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [repository],
          getRepository: () => repository
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
  env: { clipboard: { readText: async () => '' } }
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
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} finally {
  Module._load = originalLoad;
}
