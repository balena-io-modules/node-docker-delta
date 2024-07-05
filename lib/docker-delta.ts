import path from 'node:path';
import Bluebird from 'bluebird';
import stream from 'node:stream';
import { TypedError } from 'typed-error';
import * as rsync from './rsync';
import * as btrfs from './btrfs';
import { spawn } from './utils';
import type Dockerode from 'dockerode';
import * as dt from 'docker-toolbelt';

const DELTA_OUT_OF_SYNC_CODES = [19, 23, 24];

const RSYNC_EXIT_TIMEOUT = 10 * 60 * 1000;

export class OutOfSyncError extends TypedError {
	// noop
}

export const createDelta = function (
	docker: Dockerode,
	srcImage: string,
	destImage: string,
	v2 = true,
	{
		log = function () {
			// noop
		},
		ioTimeout = 0,
	}: { log?: typeof console.log; ioTimeout?: number } = {},
) {
	const deltaStream = new stream.PassThrough();
	const config = docker
		.getImage(destImage)
		.inspect()
		.then(({ Config }) => Config);

	dt.withImageRootDirMounted(docker, srcImage, (srcRoot) =>
		dt.withImageRootDirMounted(docker, destImage, async (destRoot) => {
			const [srcDir, destDir] = [srcRoot, destRoot].map((rootDir) =>
				path.join(rootDir, path.sep),
			);

			const [dockerConfig, [rsyncExit, rsyncStream]] = await Promise.all([
				config,
				rsync.createRsyncStream(srcDir, destDir, ioTimeout, log),
			]);

			if (v2) {
				const metadata = {
					version: 2,
					dockerConfig,
				};
				deltaStream.write(JSON.stringify(metadata));
				deltaStream.write(Buffer.from([0x00]));
			}
			try {
				await stream.promises.pipeline(rsyncStream, deltaStream);
			} finally {
				await rsyncExit.waitAsync();
			}
		}),
	)
		.catch(function (e) {
			deltaStream.emit('error', e);
		})
		.finally(function () {
			log('rsync exited');
			deltaStream.emit('close');
		});

	return deltaStream;
};

function bufIndexOfByte(buf: Buffer, byte: number) {
	for (let i = 0, len = buf.length; i < len; i++) {
		if (buf[i] === byte) {
			return i;
		}
	}
	return -1;
}

function parseDeltaStream(input: stream.PassThrough) {
	return new Promise<{ [key: string]: any }>(function (resolve, reject) {
		const parser = function () {
			const chunks = [];

			let chunk;
			while ((chunk = input.read()) != null) {
				chunks.push(chunk);
			}

			const buf = Buffer.concat(chunks);

			const sep = bufIndexOfByte(buf, 0x00);
			if (sep !== -1) {
				input.removeListener('readable', parser);
				input.unshift(buf.slice(sep + 1));

				try {
					const metadata = JSON.parse(buf.slice(0, sep).toString());
					if (metadata.version === 2) {
						resolve(metadata);
					} else {
						reject(new Error('Unknown version: ' + metadata.version));
					}
				} catch (error) {
					reject(error);
				}
			}
		};

		input.on('readable', parser);
	});
}

async function hardlinkCopy(
	srcRoot: string,
	dstRoot: string,
	linkDests: string[],
) {
	const rsyncArgs = ['--archive', '--delete'];

	for (let j = 0, len = linkDests.length; j < len; j++) {
		const dest = linkDests[j];
		rsyncArgs.push('--link-dest', dest);
	}
	rsyncArgs.push(srcRoot, dstRoot);

	await spawn('rsync', rsyncArgs).waitAsync();
}

async function applyBatch(
	rsyncProcess: ReturnType<typeof spawn>,
	batch: stream.PassThrough,
	timeout: number,
	log: typeof console.log,
) {
	let p = stream.promises.pipeline(batch, rsyncProcess.stdin!);

	if (timeout !== 0) {
		p = Bluebird.resolve(p).timeout(timeout);
	}

	try {
		await p;
		log('Batch input stream ended; waiting for rsync...');
		try {
			await Bluebird.resolve(await rsyncProcess.waitAsync()).timeout(
				RSYNC_EXIT_TIMEOUT,
			);
			log('rsync exited cleanly');
		} catch (err) {
			log('Error waiting for rsync to exit: ' + err);
			throw err;
		}
	} catch (err) {
		log('Killing rsync with force due to error: ' + err);
		rsyncProcess.kill('SIGUSR1');
		log('Waiting for rsync to exit...');
		await rsyncProcess.waitAsync();
		throw err;
	}
}

export const applyDelta = function (
	docker: Dockerode,
	srcImage: string,
	{
		log = function () {
			// noop
		},
		timeout = 0,
	}: { log?: typeof console.log; timeout?: number } = {},
) {
	const deltaStream = new stream.PassThrough();
	const dstIdPromise = parseDeltaStream(deltaStream).then(
		async ({ dockerConfig }) => {
			log('Extracted image config');
			const id = await dt.createEmptyImage(docker, dockerConfig);
			log('Created empty image ' + id);
			return id;
		},
	);

	function rootDirFunc<T>(img: string, fn: (rootDir?: string) => T) {
		return srcImage != null
			? dt.withImageRootDirMounted(docker, img, fn)
			: fn();
	}

	rootDirFunc(srcImage, async function (srcRoot) {
		if (srcRoot != null) {
			srcRoot = path.join(srcRoot, '/');
		}

		const [dockerDriver, dstId, $dstRoot] = await Promise.all([
			docker.info().then(({ Driver }) => Driver),
			dstIdPromise,
			dstIdPromise.then((id) => dt.imageRootDir(docker, id)),
		]);
		const dstRoot = path.join($dstRoot, '/');
		switch (dockerDriver) {
			case 'btrfs':
				if (srcRoot != null) {
					await btrfs.deleteSubvolAsync(dstRoot);
					await btrfs.snapshotSubvolAsync(srcRoot, dstRoot);
				}
				break;
			case 'overlay':
				if (srcRoot != null) {
					await hardlinkCopy(srcRoot, dstRoot, [srcRoot]);
				}
				break;
			case 'aufs':
			case 'overlay2':
				if (srcRoot != null) {
					const diffPaths = await dt.diffPaths(docker, srcImage);
					await hardlinkCopy(srcRoot, dstRoot, diffPaths);
				}
				break;
			default:
				throw new Error('Unsupported driver ' + dockerDriver);
		}
		log("Hard-linked files from '" + srcRoot + "' to '" + dstRoot + "'");
		const rsyncArgs = ['--archive', '--delete', '--read-batch', '-', dstRoot];
		log('Spawning rsync with arguments ' + rsyncArgs.join(' '));
		const ps = spawn('rsync', rsyncArgs, {
			stdio: ['pipe', 'ignore', 'ignore'],
		});
		await applyBatch(ps, deltaStream, timeout, log);
		log('rsync exited successfully');
		log("fsync'ing...");
		await spawn('sync').waitAsync();
		log('All done. Image ID: ' + dstId);
		deltaStream.emit('id', dstId);
	}).catch(async function (e) {
		log('Error: ' + e);
		if (e.code != null && DELTA_OUT_OF_SYNC_CODES.indexOf(e.code) >= 0) {
			deltaStream.emit('error', new OutOfSyncError('Incompatible image'));
		} else {
			deltaStream.emit('error', e);
		}
		const dstId = await dstIdPromise;
		try {
			await docker.getImage(dstId).remove();
		} catch (e2) {
			deltaStream.emit('error', e2);
		}
	});
	return deltaStream;
};
