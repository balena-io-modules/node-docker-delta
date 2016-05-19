{ spawn } = require 'child_process'

utils = require './utils'

# Returns a promise that settles after the subvolume `subvol` has been deleted
exports.deleteSubvolAsync = (subvol) ->
	utils.waitPidAsync(spawn('btrfs', [ 'subvolume', 'delete', subvol]))

# Returns a promise that settles after a snapshot of the subvolume `src` has
# been created at `dest`
exports.snapshotSubvolAsync = (src, dest) ->
	# console.log('btrfs subvolume snapshot', src, dest)
	utils.waitPidAsync(spawn('btrfs', [ 'subvolume', 'snapshot', src, dest ]))
