all:

lint:
	@node_modules/.bin/eslint .

test:
	@node_modules/.bin/mocha

debugtest:
	# This is known to work on node 7.6.0.
	@node_modules/.bin/mocha --inspect --debug-brk

.PHONY: all lint test debugtest
