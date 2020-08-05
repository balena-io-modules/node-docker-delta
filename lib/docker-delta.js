import * as path from 'path';
import * as Promise from 'bluebird';
import * as stream from 'readable-stream';
const TypedError = require('typed-error');
import * as rsync from './rsync';
import * as btrfs from './btrfs';
import { spawn } from './utils';
const Docker = require('docker-toolbelt');

// @ts-expect-error
const docker = new Docker();

// code 19 isn't found in rsync's man pages.
const DELTA_OUT_OF_SYNC_CODES = [19, 23, 24];

// We set a large timeout (10 minutes) for rsync to exit after applying the batch.
// For most cases 5 seconds is more than enough, but in systems with slow IO
// it can be a bit longer.
const RSYNC_EXIT_TIMEOUT = 10 * 60 * 1000;

export class OutOfSyncError extends TypedError {}

// Takes two strings `srcImage` and `destImage` which represent docker images
// that are already present in the docker daemon and returns a Readable stream
// of the binary diff between the two images.
//
// The stream format is the following where || means concatenation:
//
// result := jsonMetadata || 0x00 || rsyncData
export function createDelta(srcImage, destImage, v2, opts) {
	if (v2 == null) {
		v2 = true;
	}
	if (opts == null) {
		opts = {};
	}
	let { log, ioTimeout } = opts;
	if (log == null) {
		log = function () {
			// noop
		};
	}
	if (ioTimeout == null) {
		ioTimeout = 0;
	}

	// We need a passthrough stream so that we can return it immediately while the
	// promises are in progress
	const deltaStream = new stream.PassThrough();

	// We retrieve the container config for the image
	const configPromise = docker
		.getImage(destImage)
		.inspect()
		.then(({ Config }) => Config);

	// We then get the two root directories and then apply rsync on them
	const rootDirFunc = docker.imageRootDirMounted.bind(docker);
	const rootDirDisposers = [srcImage, destImage].map(rootDirFunc);
	Promise.using(rootDirDisposers, function (rootDirs) {
		const [srcDir, destDir] = rootDirs.map((rootDir) =>
			path.join(rootDir, path.sep),
		);
		const rsyncPromise = rsync.createRsyncStream(
			srcDir,
			destDir,
			ioTimeout,
			log,
		);

		return Promise.join(configPromise, rsyncPromise, function (
			config,
			[rsyncExit, rsyncStream],
		) {
			if (v2) {
				const metadata = {
					version: 2,
					dockerConfig: config,
				};

				// Write the header of the delta format which is the serialised metadata
				deltaStream.write(JSON.stringify(metadata));
				// Write the NUL byte separator for the rsync binary stream
				deltaStream.write(new Buffer([0x00]));
			}
			// Write the rsync binary stream
			return new Promise((resolve, reject) =>
				rsyncStream.on('error', reject).on('close', resolve).pipe(deltaStream),
			).finally(() => rsyncExit.waitAsync());
		});
	})
		.catch((e) => deltaStream.emit('error', e))
		.finally(function () {
			log('rsync exited');
			return deltaStream.emit('close');
		});

	return deltaStream;
}

const bufIndexOfByte = function (buf, byte) {
	for (let i = 0; i < buf.length; i++) {
		const b = buf[i];
		if (b === byte) {
			return i;
		}
	}
	return -1;
};

// Parses the input stream `input` and returns a promise that will resolve to
// the parsed JSON metadata of the delta stream. The input stream is consumed
// exactly up to and including the separator so that it can be piped directly
// to rsync after the promise resolves.
const parseDeltaStream = (input) =>
	new Promise(function (resolve, reject) {
		let buf = new Buffer(0);

		var parser = function () {
			// Read all available data
			let chunk;
			const chunks = [buf];
			// tslint:disable-next-line:no-conditional-assignment
			while ((chunk = input.read())) {
				chunks.push(chunk);
			}

			// FIXME: Implement a sensible upper bound on the size of metadata
			// and reject with an error if we get above that
			buf = Buffer.concat(chunks);

			const sep = bufIndexOfByte(buf, 0x00);

			if (sep !== -1) {
				// We no longer have to parse the input
				let metadata;
				input.removeListener('readable', parser);

				// The data after the separator are rsync binary data so we put
				// them back for the next consumer to process
				input.unshift(buf.slice(sep + 1));

				// Parse JSON up until the separator
				try {
					// @ts-expect-error
					metadata = JSON.parse(buf.slice(0, sep));
				} catch (e) {
					return reject(e);
				}

				// Sanity check
				if (metadata.version === 2) {
					return resolve(metadata);
				} else {
					return reject(new Error('Uknown version: ' + metadata.version));
				}
			}
		};

		return input.on('readable', parser);
	});

const nullDisposer = (_image) => Promise.resolve(null);

const hardlinkCopy = function (srcRoot, dstRoot, linkDests) {
	const rsyncArgs = ['--archive', '--delete'];
	for (let dest of linkDests) {
		rsyncArgs.push('--link-dest', dest);
	}
	rsyncArgs.push(srcRoot, dstRoot);
	const rsyncProc = spawn('rsync', rsyncArgs);
	// @ts-expect-error
	return rsyncProc.waitAsync();
};

const applyBatch = function (rsyncProc, batch, timeout, log) {
	let p = new Promise((resolve, reject) =>
		batch
			.on('error', reject)
			.on('finish', function () {
				// There seems to be a race condition between
				// rsync exiting and it's stdin pipe being closed. If
				// the stdin is not closed, the delta application never
				// finishes. Due to this, once the batch has fully
				// drained, we force close stdin. We did have this
				// change in the rsync.on('close') handler, but that
				// only worked some of the time. Anecdotal evidence
				// says that this works all of the time, and it's also
				// technically correct, the best kind. Be careful
				// removing this, as it seems to be required post node8.
				rsyncProc.stdin.end();
				return resolve();
			})
			.pipe(rsyncProc.stdin)
			.on('error', reject)
			.on('finish', resolve),
	);

	if (timeout !== 0) {
		p = p.timeout(timeout);
	}

	return p
		.then(function () {
			log('Batch input stream ended; waiting for rsync...');
			// `p` is resolved on 'finish' but that doesn't guarantee rsync exited cleanly :/
			// normally we'd end up here on rsync exiting with 0, but there are cases
			// our pipe to its stdin is broken with no error and rsync still is up.
			// so to find the reason rsync exited, we "poll" it once here via `waitAsync`.
			// if rsync exited cleanly, `waitAsync` will resolve and the chain continues.
			// for any other case, a short timeout will ensure we don't wait forever and
			// manually kill rsync below.
			return rsyncProc
				.waitAsync()
				.timeout(RSYNC_EXIT_TIMEOUT)
				.tap(() => log('rsync exited cleanly'))
				.tapCatch((err) => log(`Error waiting for rsync to exit: ${err}`));
		})
		.catch(function (err) {
			log(`Killing rsync with force due to error: ${err}`);
			rsyncProc.kill('SIGUSR1');
			log('Waiting for rsync to exit...');
			return rsyncProc.waitAsync().throw(err);
		});
};

export function applyDelta(srcImage, opts) {
	if (opts == null) {
		opts = {};
	}
	let { timeout, log } = opts;
	if (log == null) {
		log = function () {
			// noop
		};
	}
	if (timeout == null) {
		timeout = 0;
	}

	const deltaStream = new stream.PassThrough();
	let rootDirFunc = nullDisposer;
	if (srcImage != null) {
		rootDirFunc = docker.imageRootDirMounted.bind(docker);
	}

	const dstIdPromise = parseDeltaStream(deltaStream)
		.get('dockerConfig')
		.tap(() => log('Extracted image config'))
		.bind(docker)
		.then(docker.createEmptyImage)
		.tap((id) => log(`Created empty image ${id}`));

	Promise.using(rootDirFunc(srcImage), function (srcRoot) {
		if (srcRoot != null) {
			srcRoot = path.join(srcRoot, '/');
		}

		return Promise.join(
			docker.info().then(({ Driver }) => Driver),
			dstIdPromise,
			dstIdPromise.then(docker.imageRootDir),
			function (dockerDriver, dstId, dstRoot) {
				// trailing slashes are significant for rsync
				dstRoot = path.join(dstRoot, '/');

				return Promise.try(function () {
					switch (dockerDriver) {
						case 'btrfs':
							if (srcRoot != null) {
								return btrfs
									.deleteSubvolAsync(dstRoot)
									.then(() => btrfs.snapshotSubvolAsync(srcRoot, dstRoot));
							}
							break;
						case 'overlay':
							if (srcRoot != null) {
								return hardlinkCopy(srcRoot, dstRoot, [srcRoot]);
							}
							break;
						case 'aufs':
						case 'overlay2':
							if (srcRoot != null) {
								return docker
									.diffPaths(srcImage)
									.then((diffPaths) =>
										hardlinkCopy(srcRoot, dstRoot, diffPaths),
									);
							}
							break;
						default:
							throw new Error(`Unsupported driver ${dockerDriver}`);
					}
				})
					.then(function () {
						log(`Hard-linked files from '${srcRoot}' to '${dstRoot}'`);

						const rsyncArgs = [
							'--archive',
							'--delete',
							'--read-batch',
							'-',
							dstRoot,
						];

						log(`Spawning rsync with arguments ${rsyncArgs.join(' ')}`);

						const rsyncProc = spawn('rsync', rsyncArgs, {
							// pipe stdin, ignore stdout/stderr
							stdio: ['pipe', 'ignore', 'ignore'],
						});
						return applyBatch(rsyncProc, deltaStream, timeout, log).tap(() =>
							log('rsync exited successfully'),
						);
					})
					.then(function () {
						log("fsync'ing...");
						// rsync doesn't fsync by itself
						// @ts-expect-error
						return spawn('sync').waitAsync();
					})
					.then(function () {
						log(`All done. Image ID: ${dstId}`);
						return deltaStream.emit('id', dstId);
					});
			},
		);
	}).catch(function (e) {
		log(`Error: ${e}`);
		if (DELTA_OUT_OF_SYNC_CODES.includes(e?.code)) {
			deltaStream.emit('error', new OutOfSyncError('Incompatible image'));
		} else {
			deltaStream.emit('error', e);
		}
		// If the process failed for whatever reason, cleanup the empty image
		return dstIdPromise.then((dstId) =>
			docker
				.getImage(dstId)
				.remove()
				.catch((err) => deltaStream.emit('error', err)),
		);
	});

	return deltaStream;
}
