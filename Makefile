#
# Copyright (c) 2018, Joyent, Inc. All rights reserved.
#
# Makefile: top-level Makefile
#
# This Makefile contains only repo-specific logic and uses included makefiles
# to supply common targets (javascriptlint, jsstyle, restdown, etc.), which are
# used by other repos as well.
#

#
# Tools must be installed on the path
#
JSL		 = jsl
JSSTYLE		 = jsstyle
CATEST		 = deps/catest/catest

#
# Files
#
JS_FILES	:= $(shell find bin etc lib test -name '*.js')
JSON_FILES      := package.json $(shell find etc test -name '*.json')
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSL_CONF_NODE	 = jsl.node.conf
CLEAN_FILES	+= node_modules

#
# Guard tests from mistakenly being run against production
#
GUARD			= test/.not_production
DEFAULT_TEST_CONFIG	= test/etc/testconfig.json
TEST_BACKEND_URL	:= $(shell json -f $(DEFAULT_TEST_CONFIG) dbs | json -a url)


all:
	npm install

test: $(GUARD) all
	$(CATEST) test/*.tst.js

$(GUARD):
	@echo

	@echo "Test configuration is pointed at $(TEST_BACKEND_URL)."
	@echo
	@echo "Verify that this is _not_ a production database and create \
	the blank file:"
	@echo
	@echo "\t$(GUARD)"
	@echo
	@echo "Tests will not run until this file is present."

	@echo
	@exit 1


include ./Makefile.targ
