VSCE ?= npx --no-install @vscode/vsce
CODE ?= code
VSIX := $(shell node -p "require('./package.json').name + '-' + require('./package.json').version + '.vsix'")

.PHONY: test package install

test:
	npm test

package: test
	$(VSCE) package

install: package
	$(CODE) --install-extension "$(VSIX)" --force
