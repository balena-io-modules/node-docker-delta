/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
import { spawn } from './utils';

// Returns a promise that settles after the subvolume `subvol` has been deleted
export function deleteSubvolAsync(subvol) {
	// @ts-expect-error
	return spawn('btrfs', ['subvolume', 'delete', subvol]).waitAsync();
}

// Returns a promise that settles after a snapshot of the subvolume `src` has
// been created at `dest`
export function snapshotSubvolAsync(src, dest) {
	// console.log('btrfs subvolume snapshot', src, dest)
	// @ts-expect-error
	return spawn('btrfs', ['subvolume', 'snapshot', src, dest]).waitAsync();
}
