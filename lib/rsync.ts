import fs from 'node:fs';
import tmp from 'tmp-promise';
import path from 'node:path';
import { spawn, mkfifoSync } from './utils';

export const createRsyncStream = async function (
	src: string,
	dest: string,
	ioTimeout: number,
	log: typeof console.log,
) {
	let tmpDirPath: string;
	let cleanup: () => Promise<void>;
	try {
		({ path: tmpDirPath, cleanup } = await tmp.dir({
			unsafeCleanup: true,
		}));
	} catch (err) {
		log('Failed to create temporary directory');
		throw err;
	}
	const pipePath = path.join(tmpDirPath, 'rsync.pipe');
	mkfifoSync(pipePath);
	const rsyncArgs = [
		'--archive',
		'--compress',
		'--checksum',
		'--no-i-r',
		'--delete',
		'--hard-links',
		'--timeout',
		`${ioTimeout}`,
		'--compress-level=9',
		'--one-file-system',
		'--only-write-batch',
		pipePath,
		dest,
		src,
	];
	log('Invoking rsync:', 'rsync ' + rsyncArgs.join(' '));
	const ps = spawn('rsync', rsyncArgs, {
		stdio: 'ignore',
	});
	return new Promise<[ReturnType<typeof spawn>, fs.ReadStream]>(
		(resolve, reject) => {
			fs.open(pipePath, 'r', async function (error, fd) {
				let stream;
				if (error) {
					log('Failed to open pipe for reading. Killing rsync...');
					ps.kill('SIGUSR1');
					try {
						await ps.waitAsync();
						log('rsync exited');
					} catch (e) {
						log('rsync exited with error: ' + e);
					} finally {
						void cleanup();
						reject(error);
					}
				} else {
					stream = fs
						.createReadStream('', {
							fd: fd,
						})
						.on('close', cleanup);
					resolve([ps, stream]);
				}
			});
		},
	);
};
