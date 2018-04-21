#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

printf '==> firstboot @ %s\n' "$(date -u +%FT%TZ)"

set -o xtrace

NAME=pgstatsmon

#
# Runs on first boot of a newly reprovisioned "pgstatsmon" zone.
#

SVC_ROOT="/opt/smartdc/$NAME"

#
# Build PATH from this list of directories.  This PATH will be used both in the
# execution of this script, as well as in the root user .bashrc file.
#
paths=(
	"$SVC_ROOT/bin"
	"$SVC_ROOT/node_modules/.bin"
	"$SVC_ROOT/node/bin"
	"/opt/local/bin"
	"/opt/local/sbin"
	"/usr/sbin"
	"/usr/bin"
	"/sbin"
)


PATH=
for (( i = 0; i < ${#paths[@]}; i++ )); do
	if (( i > 0 )); then
		PATH+=':'
	fi
	PATH+="${paths[$i]}"
done
export PATH

if ! source "$SVC_ROOT/scripts/util.sh" ||
    ! source "$SVC_ROOT/scripts/services.sh"; then
	exit 1
fi

manta_common_presetup

manta_add_manifest_dir "/opt/smartdc/$NAME"

manta_common_setup "$NAME"

#
# Replace the contents of PATH from the default root user .bashrc with one
# more appropriate for this particular zone.
#
if ! /usr/bin/ed -s '/root/.bashrc'; then
	fatal 'could not modify .bashrc'
fi <<EDSCRIPT
/export PATH/d
a
export PATH="$PATH"
.
w
EDSCRIPT

#
# Import the pgstatsmon SMF service.  The manifest file creates the service
# enabled by default.
#
if ! svccfg import "/opt/smartdc/$NAME/smf/manifests/$NAME.xml"; then
	fatal 'could not import SMF service'
fi

manta_common_setup_end
