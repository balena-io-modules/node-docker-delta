import { spawn, execSync } from 'child_process';
import * as Promise from 'bluebird';

// Similar to waitpid(), it gets an instance of ChildProcess and returns a
// promise that settles after the process has stopped or errored
const waitPidAsync = (cmd, ps, status) =>
	new Promise(function (resolve, reject) {
		const handleExit = function (code, signal) {
			if (code !== 0) {
				const error = new Error(
					`${cmd} exited. code: ${code} signal: ${signal}`,
				);
				// @ts-expect-error
				error.code = code;
				// @ts-expect-error
				error.signal = signal;
				return reject(error);
			} else {
				return resolve();
			}
		};
		if (status.exited) {
			return handleExit(status.code, status.signal);
		} else if (status.error != null) {
			return reject(status.error);
		} else {
			return ps.on('error', reject).on('exit', handleExit);
		}
	});

function _spawn(cmd, args, opts) {
	const ps = spawn(cmd, args, opts);
	const processStatus = {
		exited: false,
		code: null,
		signal: null,
		error: null,
	};
	ps.on('error', (e) => {
		// @ts-expect-error
		processStatus.error = e;
	});
	ps.on('exit', function (code, signal) {
		processStatus.exited = true;
		// @ts-expect-error
		processStatus.code = code;
		// @ts-expect-error
		processStatus.signal = signal;
	});
	// @ts-expect-error
	ps.waitAsync = () => waitPidAsync(cmd, ps, processStatus);
	return ps;
}

export { _spawn as spawn };

export function mkfifoSync(fifoPath) {
	return execSync(`mkfifo -m 0600 ${fifoPath}`);
}
