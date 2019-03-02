#!/usr/bin/env bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2019, Joyent, Inc.
#

#
# This script updates the zone's metricPorts mdata variable with the current
# port value from pgstatsmon's config file, with the intent of keeping the mdata
# value in sync with the port currently being used by pgstatsmon. To this end,
# this script's SMF manifest is configured to run the script every time the
# pgstatsmon service is refreshed or restarted.
#

SVC_NAME=pgstatsmon
SVC_ROOT="/opt/smartdc/$SVC_NAME"
SAPI_CONFIG="$SVC_ROOT/etc/config.json"

set -o errexit
set -o pipefail
set -o xtrace

if ! source "$SVC_ROOT/scripts/util.sh"; then
    exit 1
fi

# Get the metricPort from the sapi config file to allow scraping by cmon-agent.
#
# Note: If the config file doesn't exist, the script will fail - but so will
# pgstatsmon itself, because it depends on the existence of the config file to
# run.
if [[ ! -f "$SAPI_CONFIG" ]]; then
    fatal "SAPI config not found"
fi
mdata-put metricPorts $(< "$SAPI_CONFIG" json "target.port")
