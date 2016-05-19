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


# Durably write a file `file` containing the data `data`.
# Returns a promise that settles after all the operations have succeeded
exports.durableWriteFileAsync = (file, data) ->
	tmpFile = file + '.tmp'

	fs.writeFileAsync(tmpFile, data, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
	fs.openAsync(tmpFile, constants.O_RDONLY)
	.tap(fs.fsyncAsync)
	.then(fs.closeAsync)
	.then ->
		fs.renameAsync(tmpFile, file)
	.then ->
		fs.openAsync(path.dirname(file), constants.O_DIRECTORY)
	.tap(fs.fsyncAsync)
	.then(fs.closeAsync)
