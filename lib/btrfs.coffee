{ spawn } = require './utils'

# Returns a promise that settles after the subvolume `subvol` has been deleted
exports.deleteSubvolAsync = (subvol) ->
	spawn('btrfs', [ 'subvolume', 'delete', subvol]).waitAsync()

# Returns a promise that settles after a snapshot of the subvolume `src` has
# been created at `dest`
exports.snapshotSubvolAsync = (src, dest) ->
	# console.log('btrfs subvolume snapshot', src, dest)
	spawn('btrfs', [ 'subvolume', 'snapshot', src, dest ]).waitAsync()
