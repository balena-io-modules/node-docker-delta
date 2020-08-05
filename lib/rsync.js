import * as Promise from 'bluebird';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as path from 'path';
import { spawn, mkfifoSync } from './utils';

export function createRsyncStream(src, dest, ioTimeout, log) {
	return new Promise((resolve, reject) =>
		tmp.dir({ unsafeCleanup: true }, function (err, tmpDirPath, cleanup) {
			if (err) {
				log('Failed to create temporary directory');
				return reject(err);
			}

			const pipePath = path.join(tmpDirPath, 'rsync.pipe');

			mkfifoSync(pipePath);

			// To produce the delta that takes us from `src` to `dest`
			// we have to tell rsync to copy `dest` to `src`
			const rsyncArgs = [
				'--archive',
				'--compress',
				'--checksum',
				'--no-i-r',
				'--delete',
				'--hard-links',

				'--timeout',
				ioTimeout, // in seconds

				'--compress-level=9',
				'--one-file-system',
				'--only-write-batch',
				pipePath,
				dest,
				src,
			];

			log('Invoking rsync:', 'rsync ' + rsyncArgs.join(' '));
			const ps = spawn('rsync', rsyncArgs, { stdio: 'ignore' });

			// Early Node 8 versions have a bug that force a seek upon creation of
			// a read stream. The workaround is to pass the file descriptor directly.
			// See: https://github.com/nodejs/node/issues/19240
			return fs.open(pipePath, 'r', function (err2, fd) {
				if (err2) {
					log('Failed to open pipe for reading. Killing rsync...');
					ps.kill('SIGUSR1');
					return (
						ps
							// @ts-expect-error
							.waitAsync()
							.tap(() => log('rsync exited'))
							.tapCatch((e) => log(`rsync exited with error: ${e}`))
							.finally(function () {
								cleanup();
								return reject(err2);
							})
					);
				} else {
					const stream = fs
						// @ts-expect-error
						.createReadStream(undefined, { fd })
						.on('close', cleanup);
					return resolve([ps, stream]);
				}
			});
		}),
	);
}
