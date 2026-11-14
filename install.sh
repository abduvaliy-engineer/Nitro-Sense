#!/usr/bin/env bash
# The installer is nitrosense.sh since 1.0. Live Update in NitroSense 0.15.1 and older runs the new release's
# install.sh --update, so this name stays and passes everything on.
exec bash "$(dirname "$0")/nitrosense.sh" "$@"
