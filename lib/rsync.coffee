Promise = require 'bluebird'
fs = require 'fs'
tmp = require 'tmp'
path = require 'path'
mkfifoSync = require('mkfifo').mkfifoSync
{ spawn } = require 'child_process'

exports.createRsyncStream = (src, dest) ->
	console.error('CREATING STREAM', src, 'dest', dest)
	new Promise (resolve, reject) ->
		tmp.dir unsafeCleanup: true, (err, tmpDirPath, cleanup) ->
			pipePath = path.join(tmpDirPath, 'rsync.pipe')

			mkfifoSync(pipePath, 0o600)

			# To produce the delta that takes us from `src` to `dest`
			# we have to tell rsync to copy `dest` to `src`
			rsyncArgs = [
				'--archive'
				'--compress'
				'--no-i-r'
				'--delete'
				'--hard-links'

				'--compress-level=9'
				'--one-file-system'
				'--only-write-batch', pipePath
				dest, src
			]

			# Piping to cat causes /dev/stdout to be a pipe instead of a socket which
			# allows rsync to open() it and write the batch file.
			console.error('Invoking rsync:', 'rsync ' + rsyncArgs.join(' '))

			ps = spawn('rsync', rsyncArgs)
			.on 'error', (error) ->
				console.error('rsync error', error)
				ps.stdout.emit('error', error)
			.on 'exit', (code, signal) ->
				if code isnt 0
					console.error('rsync error', error)
					ps.stdout.emit('error', new Error("rsync exited. code: #{code} signal: #{signal}"))

			ps.stderr.pipe(process.stderr)
			ps.stdout.pipe(process.stdout)

			resolve(fs.createReadStream(pipePath).on('close', cleanup))
