# yootri has no build step, so there is nothing here that compiles anything.
# This file exists to make the two things you actually do — serve the folder and
# run the checks CI runs — one word each, and to keep the dev URL spelled
# `localhost`, which is what makes Google sign-in work locally.
#
#   make dev              serve on http://localhost:8000/ and open a browser
#   make dev PORT=8001    when 8000 is taken
#   make dev OPEN=0       do not open a browser
#   make stop             free port 8000 (a server outlives a closed terminal)
#   make check            everything CI runs: unit tests + repo hygiene
#
#   make garmin-login     sign in to Garmin once (personal use; see tools/garmin-bridge)
#   make garmin           run the Garmin bridge while you sync from the page

PORT ?= 8000
OPEN ?= 1
GARMIN_PORT ?= 8765

# The Garmin bridge is the one part of yootri that is not plain files: a small
# Python program run with uv. Everything else works without either.
BRIDGE = uv run --directory tools/garmin-bridge
NEED_UV = command -v uv >/dev/null 2>&1 || { \
	echo "  The Garmin bridge runs with uv: https://docs.astral.sh/uv/getting-started/installation/"; \
	exit 1; }

.DEFAULT_GOAL := dev
.PHONY: dev stop test hygiene check help garmin garmin-login garmin-logout garmin-status garmin-test

## dev: serve at http://localhost:8000/ (PORT=8001 to change)
dev:
	@PORT=$(PORT) OPEN=$(OPEN) node tools/dev-server.mjs

## stop: stop whatever is serving on PORT (a dev server outlives a closed terminal)
stop:
	@pids=$$(lsof -ti tcp:$(PORT) 2>/dev/null); \
	if [ -z "$$pids" ]; then \
		echo "  Nothing is listening on port $(PORT)."; \
	else \
		for pid in $$pids; do \
			echo "  Stopping $$(ps -o comm= -p $$pid 2>/dev/null | xargs) (pid $$pid) on port $(PORT)."; \
		done; \
		kill $$pids; \
	fi

## test: run the engine unit tests
test:
	@npm test

## hygiene: nothing private, no credentials, no broken links
hygiene:
	@node .github/scripts/check-repo-hygiene.mjs

## check: everything CI runs, before you push
check: test hygiene
	@if command -v uv >/dev/null 2>&1; then $(BRIDGE) pytest -q; \
	else echo "  Garmin bridge tests skipped: uv is not installed."; fi

## garmin-login: sign in to Garmin once — only the session is saved, never the password
garmin-login:
	@$(NEED_UV); $(BRIDGE) python -m garmin_bridge login

## garmin: run the Garmin bridge on 127.0.0.1:8765 while you sync (GARMIN_PORT to change)
garmin:
	@$(NEED_UV); $(BRIDGE) python -m garmin_bridge serve --port $(GARMIN_PORT) \
		--allow-origin http://localhost:$(PORT)

## garmin-status: is a Garmin session saved on this machine?
garmin-status:
	@$(NEED_UV); $(BRIDGE) python -m garmin_bridge status

## garmin-logout: delete the saved Garmin session
garmin-logout:
	@$(NEED_UV); $(BRIDGE) python -m garmin_bridge logout

## garmin-test: the bridge's own tests (no network, no Garmin account)
garmin-test:
	@$(NEED_UV); $(BRIDGE) pytest -q

## help: list these targets
help:
	@echo
	@echo "  yootri"
	@echo
	@grep -E '^## ' $(MAKEFILE_LIST) | sed -e 's/^## /  make /' -e 's/:/\t/' | expand -t 22
	@echo
