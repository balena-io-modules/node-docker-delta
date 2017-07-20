path = require 'path'

Promise = require 'bluebird'
stream = require 'readable-stream'
TypedError = require 'typed-error'

rsync = require './rsync'
btrfs = require './btrfs'
{ spawn } = require './utils'
Docker = require 'docker-toolbelt'

docker = new Docker()

DELTA_OUT_OF_SYNC_CODES = [23, 24]
RSYNC_TIMEOUT = 1800

exports.OutOfSyncError = class OutOfSyncError extends TypedError

# Takes two strings `srcImage` and `destImage` which represent docker images
# that are already present in the docker daemon and returns a Readable stream
# of the binary diff between the two images.
#
# The stream format is the following where || means concatenation:
#
# result := jsonMetadata || 0x00 || rsyncData
exports.createDelta = (srcImage, destImage, v2 = true) ->
	# We need a passthrough stream so that we can return it immediately while the
	# promises are in progress
	deltaStream = new stream.PassThrough()

	# We retrieve the container config for the image
	config = docker.getImage(destImage).inspect().get('Config')

	# We then get the two root directories and then apply rsync on them
	rootDirFunc = docker.imageRootDirMounted.bind(docker)
	rootDirDisposers = [ srcImage, destImage ].map(rootDirFunc)
	Promise.using rootDirDisposers, (rootDirs) ->
		[ srcDir, destDir ] = rootDirs.map (rootDir) -> path.join(rootDir, path.sep)
		rsyncStream = rsync.createRsyncStream(srcDir, destDir)

		Promise.join config, rsyncStream, (config, rsyncStream) ->
			if v2
				metadata =
					version: 2
					dockerConfig: config

				# Write the header of the delta format which is the serialised metadata
				deltaStream.write(JSON.stringify(metadata))
				# Write the NUL byte separator for the rsync binary stream
				deltaStream.write(new Buffer([ 0x00 ]))
			# Write the rsync binary stream
			new Promise (resolve, reject) ->
				rsyncStream
				.on 'error', reject
				.on 'close', resolve
				.pipe(deltaStream)
	.catch (e) ->
		deltaStream.emit('error', e)

	return deltaStream

bufIndexOfByte = (buf, byte) ->
	for b, i in buf when b is byte
		return i
	return -1

# Parses the input stream `input` and returns a promise that will resolve to
# the parsed JSON metadata of the delta stream. The input stream is consumed
# exactly up to and including the separator so that it can be piped directly
# to rsync after the promise resolves.
parseDeltaStream = (input) ->
	new Promise (resolve, reject) ->
		buf = new Buffer(0)

		parser = ->
			# Read all available data
			chunks = [ buf ]
			while chunk = input.read()
				chunks.push(chunk)

			# FIXME: Implement a sensible upper bound on the size of metadata
			# and reject with an error if we get above that
			buf = Buffer.concat(chunks)

			sep = bufIndexOfByte(buf, 0x00)

			if sep isnt -1
				# We no longer have to parse the input
				input.removeListener('readable', parser)

				# The data after the separator are rsync binary data so we put
				# them back for the next consumer to process
				input.unshift(buf[sep + 1...])

				# Parse JSON up until the separator
				try
					metadata = JSON.parse(buf[...sep])
				catch e
					return reject(e)

				# Sanity check
				if metadata.version is 2
					resolve(metadata)
				else
					reject(new Error('Uknown version: ' + metadata.version))

		input.on('readable', parser)

nullDisposer = ->
	Promise.resolve(null)

hardlinkCopy = (srcRoot, dstRoot, linkDests) ->
	rsyncArgs = [
		'--timeout', "#{RSYNC_TIMEOUT}"
		'--archive'
		'--delete'
	]
	rsyncArgs.push('--link-dest', dest) for dest in linkDests
	rsyncArgs.push(srcRoot, dstRoot)
	rsync = spawn('rsync', rsyncArgs)
	rsync.waitAsync()

exports.applyDelta = (srcImage) ->
	deltaStream = new stream.PassThrough()
	rootDirFunc = nullDisposer
	if srcImage?
		rootDirFunc = docker.imageRootDirMounted.bind(docker)

	dstIdPromise = parseDeltaStream(deltaStream).get('dockerConfig').bind(docker).then(docker.createEmptyImage)

	Promise.using rootDirFunc(srcImage), (srcRoot) ->
		srcRoot = path.join(srcRoot, '/') if srcRoot?

		Promise.join(
			docker.info().get('Driver')
			dstIdPromise
			dstIdPromise.then(docker.imageRootDir)
			(dockerDriver, dstId, dstRoot) ->
				# trailing slashes are significant for rsync
				dstRoot = path.join(dstRoot, '/')

				Promise.try ->
					switch dockerDriver
						when 'btrfs'
							if srcRoot?
								btrfs.deleteSubvolAsync(dstRoot)
								.then ->
									btrfs.snapshotSubvolAsync(srcRoot, dstRoot)
						when 'overlay'
							if srcRoot?
								hardlinkCopy(srcRoot, dstRoot, [ srcRoot ])
						when 'aufs', 'overlay2'
							if srcRoot?
								docker.diffPaths(srcImage)
								.then (diffPaths) ->
									hardlinkCopy(srcRoot, dstRoot, diffPaths)
						else
							throw new Error("Unsupported driver #{dockerDriver}")
				.then ->
					rsyncArgs = [
						'--timeout', "#{RSYNC_TIMEOUT}"
						'--archive'
						'--delete'
						'--read-batch', '-'
						dstRoot
					]
					rsync = spawn('rsync', rsyncArgs)
					deltaStream.pipe(rsync.stdin)

					rsync.waitAsync()
				.then ->
					# rsync doesn't fsync by itself
					spawn('sync').waitAsync()
				.then ->
					deltaStream.emit('id', dstId)
		)
		.catch (e) ->
			if e?.code in DELTA_OUT_OF_SYNC_CODES
				deltaStream.emit('error', new OutOfSyncError('Incompatible image'))
			else
				deltaStream.emit('error', e)
			# If the process failed for whatever reason, cleanup the empty image
			dstIdPromise.then (dstId) ->
				docker.getImage(dstId).remove()
				.catch (e) ->
					deltaStream.emit('error', e)

	return deltaStream
