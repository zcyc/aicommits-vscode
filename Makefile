VSCE ?= npx --no-install @vscode/vsce

.PHONY: test package

test:
	npm test

package: test
	$(VSCE) package
