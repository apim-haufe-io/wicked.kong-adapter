#!/bin/sh

set -e

if [ -z "$(which tsc)" ]; then
    echo "ERROR: TypeScript must be installed; run"
    echo "  npm install -g typescript"
    echo "Then try again."
    exit 1
fi

tsc 

cp -f package.json ./dist
