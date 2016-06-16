Promise = require 'bluebird'

# Similar to waitpid(), it gets an instance of ChildProcess and returns a
# promise that settles after the process has stopped or errored
exports.waitPidAsync = (ps) ->
	new Promise (resolve, reject) ->
		ps
		.on('error', reject)
		.on 'exit', (code, signal) ->
			if code isnt 0
				error = new Error("rsync exited. code: #{code} signal: #{signal}")
				error.code = code
				error.signal = signal
				reject(error)
			else
				resolve()
