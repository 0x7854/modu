#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IOS_DIR=$(dirname "$SCRIPT_DIR")
ROOT_DIR=$(dirname "$IOS_DIR")
BUILD_DIR="$ROOT_DIR/.build/ios-link-router-tests"

# Keep temporary and module-cache files inside the repository. This also works
# in sandboxes that block the default per-user temporary directory.
mkdir -p "$BUILD_DIR/tmp" "$BUILD_DIR/module-cache" "$BUILD_DIR/swift-cache"

export TMPDIR="$BUILD_DIR/tmp"
export CLANG_MODULE_CACHE_PATH="$BUILD_DIR/module-cache"
export SWIFT_MODULECACHE_PATH="$BUILD_DIR/swift-cache"

swiftc -swift-version 5 \
  "$IOS_DIR/Modu/LinkRouter.swift" \
  "$IOS_DIR/Tests/LinkRouterTests.swift" \
  -o "$BUILD_DIR/link-router-tests"

exec "$BUILD_DIR/link-router-tests"
