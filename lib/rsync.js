'use strict';

const Bluebird = require('bluebird');
const fs = require('fs');
const tmp = require('tmp');
const path = require('path');
const { spawn, mkfifoSync } = require('./utils');

exports.createRsyncStream = function (src, dest, ioTimeout, log) {
	return new Bluebird(function (resolve, reject) {
		return tmp.dir(
			{
				unsafeCleanup: true,
			},
			function (err, tmpDirPath, cleanup) {
				if (err) {
					log('Failed to create temporary directory');
					return reject(err);
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
					ioTimeout,
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
				fs.open(pipePath, 'r', function (error, fd) {
					let stream;
					if (error) {
						log('Failed to open pipe for reading. Killing rsync...');
						ps.kill('SIGUSR1');
						return ps
							.waitAsync()
							.tap(function () {
								return log('rsync exited');
							})
							.tapCatch(function (e) {
								return log('rsync exited with error: ' + e);
							})
							['finally'](function () {
								cleanup();
								return reject(error);
							});
					} else {
						stream = fs
							.createReadStream(void 0, {
								fd: fd,
							})
							.on('close', cleanup);
						return resolve([ps, stream]);
					}
				});
			},
		);
	});
};
