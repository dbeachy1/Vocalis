#!/bin/sh
set -eu

# Design section 11, item 3 (October 10, 2026): the instance's data/taproom folder (config.yaml, mcp-servers.json) is
# bound at /etc/taproom, and the data folder at /data/taproom/data, so a link at data/taproom/data on the host is a bind
# source rather than something resolved inside the container.
config_path=/etc/taproom/config.yaml
data_root=/data/taproom/data

if [ ! -f "$config_path" ]; then
    cp /opt/taproom/config.yaml "$config_path"
    chmod 0600 "$config_path"
fi

node /opt/taproom/provision-owner.mjs --check --configPath "$config_path" --dataRoot "$data_root"
exec node /opt/taproom/server.js --configPath "$config_path" --dataRoot "$data_root"
