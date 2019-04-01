#!/bin/sh

set -e

./node_modules/typescript/bin/tsc 

cp -f package.json ./dist
