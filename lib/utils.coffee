Promise = require 'bluebird'
fs = Promise.promisifyAll(require('fs'))
constants = require 'constants'

# Similar to waitpid(), it gets an instance of ChildProcess and returns a
# promise that settles after the process has stopped or errored
exports.waitPidAsync = (ps) ->
	# ps.stdout.pipe(process.stderr)
	# ps.stderr.pipe(process.stderr)
	new Promise (resolve, reject) ->
		ps
		.on('error', reject)
		.on 'exit', (code, signal) ->
			if code isnt 0
				reject(new Error("rsync exited. code: #{code} signal: #{signal}"))
			else
				resolve()
