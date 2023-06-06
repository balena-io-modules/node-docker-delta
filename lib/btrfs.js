'use strict';

const { spawn } = require('./utils');

exports.deleteSubvolAsync = function (subvol) {
	return spawn('btrfs', ['subvolume', 'delete', subvol]).waitAsync();
};

exports.snapshotSubvolAsync = function (src, dest) {
	return spawn('btrfs', ['subvolume', 'snapshot', src, dest]).waitAsync();
};
