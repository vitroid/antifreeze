SHELL := /usr/bin/env bash

NPM ?= npm
DIST_DIR ?= dist
DEPLOY_DIR ?= /var/www/antifreeze
RSYNC_OPTS ?= -av --delete

.DEFAULT_GOAL := help

.PHONY: help deps build deploy clean

help:
	@echo "Available targets:"
	@echo "  make deps    - install npm dependencies if needed"
	@echo "  make build   - build production bundle"
	@echo "  make deploy  - build and deploy to $(DEPLOY_DIR)"
	@echo "  make clean   - remove build artifacts"

deps:
	@if [[ ! -d node_modules ]]; then \
		$(NPM) install; \
	else \
		echo "node_modules already exists; skip install"; \
	fi

build: deps
	$(NPM) run build

deploy: build
	sudo mkdir -p "$(DEPLOY_DIR)"
	sudo rsync $(RSYNC_OPTS) "$(DIST_DIR)/" "$(DEPLOY_DIR)/"
	@echo "Deployed: $(DIST_DIR)/ -> $(DEPLOY_DIR)/"

clean:
	rm -rf "$(DIST_DIR)"
