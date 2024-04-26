import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as $spawn, execSync } from 'node:child_process';

interface ProcessStatus {
	exited: boolean;
	code?: number;
	signal?: string;
	error?: Error;
}

async function waitPidAsync(
	cmd: string,
	ps: ChildProcess,
	status: ProcessStatus,
) {
	await new Promise<void>(function (resolve, reject) {
		function handleExit(code?: number, signal?: string) {
			if (code !== 0) {
				const error = Object.assign(
					new Error(cmd + ' exited. code: ' + code + ' signal: ' + signal),
					{
						code: code,
						signal: signal,
					},
				);
				reject(error);
			} else {
				resolve();
			}
		}
		if (status.exited) {
			handleExit(status.code, status.signal);
		} else if (status.error != null) {
			reject(status.error);
		} else {
			ps.on('error', reject).on('exit', handleExit);
		}
	});
}

export const spawn = function (
	cmd: string,
	args: readonly string[] = [],
	opts: SpawnOptions = {},
) {
	const ps = Object.assign($spawn(cmd, args, opts), {
		waitAsync: async function () {
			await waitPidAsync(cmd, ps, processStatus);
		},
	});
	const processStatus: ProcessStatus = {
		exited: false,
	};
	ps.on('error', function (e) {
		processStatus.error = e;
	});
	ps.on('exit', function (code, signal) {
		processStatus.exited = true;
		if (code != null) {
			processStatus.code = code;
		}
		if (signal != null) {
			processStatus.signal = signal;
		}
	});
	return ps;
};

export const mkfifoSync = function (fifoPath: string) {
	return execSync('mkfifo -m 0600 ' + fifoPath);
};
