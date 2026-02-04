import { spawn } from './utils.js';

export const deleteSubvolAsync = function (subvol: string) {
	return spawn('btrfs', ['subvolume', 'delete', subvol]).waitAsync();
};

export const snapshotSubvolAsync = function (src: string, dest: string) {
	return spawn('btrfs', ['subvolume', 'snapshot', src, dest]).waitAsync();
};
