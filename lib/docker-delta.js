'use strict';

// FIXME: For some reason lint complains each of the following lines shadow a variable.
// tslint:disable:no-shadowed-variable
const path = require('path');
const Bluebird = require('bluebird');
const stream = require('readable-stream');
const TypedError = require('typed-error');
const rsync = require('./rsync');
const btrfs = require('./btrfs');
const { spawn } = require('./utils');
const Docker = require('docker-toolbelt');

const docker = new Docker();

const DELTA_OUT_OF_SYNC_CODES = [19, 23, 24];

const RSYNC_EXIT_TIMEOUT = 10 * 60 * 1000;

class OutOfSyncError extends TypedError {
	// noop
}
// tslint:enable:no-shadowed-variable

exports.createDelta = function (srcImage, destImage, v2, opts) {
	if (v2 == null) {
		v2 = true;
	}
	if (opts == null) {
		opts = {};
	}
	var { log, ioTimeout } = opts;
	if (log == null) {
		log = function () {
			// noop
		};
	}
	if (ioTimeout == null) {
		ioTimeout = 0;
	}

	const deltaStream = new stream.PassThrough();
	const config = docker.getImage(destImage).inspect().get('Config');
	const rootDirFunc = docker.imageRootDirMounted.bind(docker);
	const rootDirDisposers = [srcImage, destImage].map(rootDirFunc);

	Bluebird.using(rootDirDisposers, function (rootDirs) {
		const [srcDir, destDir] = rootDirs.map(function (rootDir) {
			return path.join(rootDir, path.sep);
		});
		const rsyncPromise = rsync.createRsyncStream(
			srcDir,
			destDir,
			ioTimeout,
			log,
		);
		return Bluebird.join(
			config,
			rsyncPromise,
			function (dockerConfig, rsyncResult) {
				const [rsyncExit, rsyncStream] = rsyncResult;
				if (v2) {
					const metadata = {
						version: 2,
						dockerConfig,
					};
					deltaStream.write(JSON.stringify(metadata));
					deltaStream.write(new Buffer([0x00]));
				}
				return new Bluebird(function (resolve, reject) {
					return rsyncStream
						.on('error', reject)
						.on('close', resolve)
						.pipe(deltaStream);
				}).finally(function () {
					return rsyncExit.waitAsync();
				});
			},
		);
	})
		.catch(function (e) {
			deltaStream.emit('error', e);
		})
		.finally(function () {
			log('rsync exited');
			deltaStream.emit('close');
		});

	return deltaStream;
};

function bufIndexOfByte(buf, byte) {
	for (var i = 0, len = buf.length; i < len; i++) {
		if (buf[i] === byte) {
			return i;
		}
	}
	return -1;
}

function parseDeltaStream(input) {
	return new Bluebird(function (resolve, reject) {
		var buf = new Buffer(0);
		const parser = function () {
			const chunks = [buf];

			while (true) {
				const chunk = input.read();
				if (chunk != null) {
					chunks.push(chunk);
				} else {
					break;
				}
			}

			buf = Buffer.concat(chunks);

			const sep = bufIndexOfByte(buf, 0x00);
			if (sep !== -1) {
				input.removeListener('readable', parser);
				input.unshift(buf.slice(sep + 1));

				try {
					const metadata = JSON.parse(buf.slice(0, sep));
					if (metadata.version === 2) {
						return resolve(metadata);
					} else {
						return reject(new Error('Uknown version: ' + metadata.version));
					}
				} catch (error) {
					return reject(error);
				}
			}
		};

		return input.on('readable', parser);
	});
}

function nullDisposer() {
	return Bluebird.resolve(null);
}

function hardlinkCopy(srcRoot, dstRoot, linkDests) {
	const rsyncArgs = ['--archive', '--delete'];

	for (var j = 0, len = linkDests.length; j < len; j++) {
		const dest = linkDests[j];
		rsyncArgs.push('--link-dest', dest);
	}
	rsyncArgs.push(srcRoot, dstRoot);

	return spawn('rsync', rsyncArgs).waitAsync();
}

function applyBatch(rsyncProcess, batch, timeout, log) {
	var p = new Bluebird(function (resolve, reject) {
		return batch
			.on('error', reject)
			.on('finish', function () {
				rsyncProcess.stdin.end();
				return resolve();
			})
			.pipe(rsyncProcess.stdin)
			.on('error', reject)
			.on('finish', resolve);
	});

	if (timeout !== 0) {
		p = p.timeout(timeout);
	}

	return p
		.then(function () {
			log('Batch input stream ended; waiting for rsync...');
			return rsyncProcess
				.waitAsync()
				.timeout(RSYNC_EXIT_TIMEOUT)
				.tap(function () {
					return log('rsync exited cleanly');
				})
				.tapCatch(function (err) {
					return log('Error waiting for rsync to exit: ' + err);
				});
		})
		.catch(function (err) {
			log('Killing rsync with force due to error: ' + err);
			rsyncProcess.kill('SIGUSR1');
			log('Waiting for rsync to exit...');
			return rsyncProcess.waitAsync().throw(err);
		});
}

exports.applyDelta = function (srcImage, opts) {
	if (opts == null) {
		opts = {};
	}
	var { log, timeout } = opts;
	if (log == null) {
		log = function () {
			// noop
		};
	}
	if (timeout == null) {
		timeout = 0;
	}

	const deltaStream = new stream.PassThrough();
	const rootDirFunc =
		srcImage != null ? docker.imageRootDirMounted.bind(docker) : nullDisposer;

	const dstIdPromise = parseDeltaStream(deltaStream)
		.get('dockerConfig')
		.tap(function () {
			return log('Extracted image config');
		})
		.bind(docker)
		.then(docker.createEmptyImage)
		.tap(function (id) {
			return log('Created empty image ' + id);
		});

	Bluebird.using(rootDirFunc(srcImage), function (srcRoot) {
		if (srcRoot != null) {
			srcRoot = path.join(srcRoot, '/');
		}

		return Bluebird.join(
			docker.info().get('Driver'),
			dstIdPromise,
			dstIdPromise.then(docker.imageRootDir),
			function (dockerDriver, dstId, dstRoot) {
				dstRoot = path.join(dstRoot, '/');
				return Bluebird.try(function () {
					switch (dockerDriver) {
						case 'btrfs':
							if (srcRoot != null) {
								return btrfs.deleteSubvolAsync(dstRoot).then(function () {
									return btrfs.snapshotSubvolAsync(srcRoot, dstRoot);
								});
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
								return docker.diffPaths(srcImage).then(function (diffPaths) {
									return hardlinkCopy(srcRoot, dstRoot, diffPaths);
								});
							}
							break;
						default:
							throw new Error('Unsupported driver ' + dockerDriver);
					}
				})
					.then(function () {
						log(
							"Hard-linked files from '" + srcRoot + "' to '" + dstRoot + "'",
						);
						const rsyncArgs = [
							'--archive',
							'--delete',
							'--read-batch',
							'-',
							dstRoot,
						];
						log('Spawning rsync with arguments ' + rsyncArgs.join(' '));
						const ps = spawn('rsync', rsyncArgs, {
							stdio: ['pipe', 'ignore', 'ignore'],
						});
						return applyBatch(ps, deltaStream, timeout, log).tap(function () {
							return log('rsync exited successfully');
						});
					})
					.then(function () {
						log("fsync'ing...");
						return spawn('sync').waitAsync();
					})
					.then(function () {
						log('All done. Image ID: ' + dstId);
						return deltaStream.emit('id', dstId);
					});
			},
		);
	}).catch(function (e) {
		log('Error: ' + e);
		if (e.code != null && DELTA_OUT_OF_SYNC_CODES.indexOf(e.code) >= 0) {
			deltaStream.emit('error', new OutOfSyncError('Incompatible image'));
		} else {
			deltaStream.emit('error', e);
		}
		return dstIdPromise.then(function (dstId) {
			return docker
				.getImage(dstId)
				.remove()
				.catch(function (e2) {
					return deltaStream.emit('error', e2);
				});
		});
	});
	return deltaStream;
};