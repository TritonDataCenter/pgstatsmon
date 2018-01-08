#
# Copyright (c) 2017, Joyent, Inc. All rights reserved.
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

#
# Files
#
JS_FILES	:= $(shell find bin etc lib test -name '*.js')
JSON_FILES      := package.json $(shell find etc test -name '*.json')
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSL_CONF_NODE	 = jsl.node.conf
CLEAN_FILES	+= node_modules

all:
	npm install

test: all
	catest test/*.tst.js

include ./Makefile.targ
