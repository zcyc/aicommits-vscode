const assert = require('node:assert/strict');
const Module = require('node:module');

const repository = {
  rootUri: { fsPath: process.cwd() },
  inputBox: { value: '' }
};
const handlers = [];
const vscode = {
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({
      get: (key, fallback) => key === 'command'
        ? "printf 'generated message\\n'"
        : fallback
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
    showErrorMessage: async message => { throw new Error(`unexpected UI error: ${message}`); }
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
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} finally {
  Module._load = originalLoad;
}
