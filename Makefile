.PHONY: install check dev build clean

node_modules: package.json bun.lock
	bun install
	@touch node_modules

install: node_modules

check: node_modules
	bun run check

format: node_modules
	bun run format

dev: node_modules
	bun run dev

build: node_modules
	bun run build

clean:
	rm -rf dist node_modules
