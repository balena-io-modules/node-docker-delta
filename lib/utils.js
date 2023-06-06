'use strict';

const { spawn, execSync } = require('child_process');

const Bluebird = require('bluebird');

function waitPidAsync(cmd, ps, status) {
	return new Bluebird(function (resolve, reject) {
		function handleExit(code, signal) {
			if (code !== 0) {
				const error = new Error(
					cmd + ' exited. code: ' + code + ' signal: ' + signal,
				);
				error.code = code;
				error.signal = signal;
				return reject(error);
			} else {
				return resolve();
			}
		}
		if (status.exited) {
			return handleExit(status.code, status.signal);
		} else if (status.error != null) {
			return reject(status.error);
		} else {
			return ps.on('error', reject).on('exit', handleExit);
		}
	});
}

exports.spawn = function (cmd, args, opts) {
	const ps = spawn(cmd, args, opts);
	const processStatus = {
		exited: false,
		code: null,
		signal: null,
		error: null,
	};
	ps.on('error', function (e) {
		processStatus.error = e;
	});
	ps.on('exit', function (code, signal) {
		processStatus.exited = true;
		processStatus.code = code;
		processStatus.signal = signal;
	});
	ps.waitAsync = function () {
		return waitPidAsync(cmd, ps, processStatus);
	};
	return ps;
};

exports.mkfifoSync = function (fifoPath) {
	return execSync('mkfifo -m 0600 ' + fifoPath);
};
