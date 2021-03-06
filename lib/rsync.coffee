Promise = require 'bluebird'
fs = require 'fs'
tmp = require 'tmp'
path = require 'path'
{ spawn, mkfifoSync } = require './utils'

exports.createRsyncStream = (src, dest, ioTimeout, log) ->
	new Promise (resolve, reject) ->
		tmp.dir unsafeCleanup: true, (err, tmpDirPath, cleanup) ->
			if err
				log('Failed to create temporary directory')
				return reject(err)

			pipePath = path.join(tmpDirPath, 'rsync.pipe')

			mkfifoSync(pipePath)

			# To produce the delta that takes us from `src` to `dest`
			# we have to tell rsync to copy `dest` to `src`
			rsyncArgs = [
				'--archive'
				'--compress'
				'--checksum'
				'--no-i-r'
				'--delete'
				'--hard-links'

				'--timeout', ioTimeout # in seconds

				'--compress-level=9'
				'--one-file-system'
				'--only-write-batch', pipePath
				dest, src
			]

			log('Invoking rsync:', 'rsync ' + rsyncArgs.join(' '))
			ps = spawn('rsync', rsyncArgs, stdio: 'ignore')

			# Early Node 8 versions have a bug that force a seek upon creation of
			# a read stream. The workaround is to pass the file descriptor directly.
			# See: https://github.com/nodejs/node/issues/19240
			fs.open pipePath, 'r', (err, fd) ->
				if err
					log('Failed to open pipe for reading. Killing rsync...')
					ps.kill('SIGUSR1')
					ps.waitAsync()
					.tap ->
						log('rsync exited')
					.tapCatch (e) ->
						log("rsync exited with error: #{e}")
					.finally ->
						cleanup()
						reject(err)
				else
					stream = fs.createReadStream(undefined, fd: fd).on('close', cleanup)
					resolve([ ps, stream ])
