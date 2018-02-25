{ spawn } = require 'child_process'
Promise = require 'bluebird'

# Similar to waitpid(), it gets an instance of ChildProcess and returns a
# promise that settles after the process has stopped or errored
waitPidAsync = (cmd, ps, status) ->
	new Promise (resolve, reject) ->
		handleExit = (code, signal) ->
			if code isnt 0
				error = new Error("#{cmd} exited. code: #{code} signal: #{signal}")
				error.code = code
				error.signal = signal
				reject(error)
			else
				resolve()
		if status.exited
			handleExit(status.code, status.signal)
		else if status.error?
			reject(status.error)
		else
			ps
			.on('error', reject)
			.on('exit', handleExit)

exports.spawn = (cmd, args, opts) ->
	ps = spawn(cmd, args, opts)
	processStatus = {
		exited: false
		code: null
		signal: null
		error: null
	}
	ps.on('error', (e) -> processStatus.error = e)
	ps.on 'exit', (code, signal) ->
		processStatus.exited = true
		processStatus.code = code
		processStatus.signal = signal
	ps.waitAsync = ->
		waitPidAsync(cmd, ps, processStatus)
	return ps
