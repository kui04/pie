#!/usr/bin/env bash
#
# Fails when a file under src/components/ui/ differs from what the shadcn
# registry writes today.
#
# The registry's files are the project's, untouched: a look is a call site's
# `className`, the theme's, or another component's - never an edit in there. This
# is what holds that rule, because `shadcn add --diff` cannot: it reports the
# repo's prettier formatting as a change on every file. So the registry is asked
# for a fresh install in a scratch project beside the repo, both sides go through
# the same prettier, and the two trees are compared.
#
# Two things this comparison deliberately ignores.
#
# - The CLI's version: `pnpm dlx` caches whatever `shadcn@latest` resolved to, and
#   the cache in this machine holds 4.21.0 through 4.21.4, so "latest" is not one
#   program from run to run. The version the repo's files were written with is
#   pinned here instead.
# - `"use client"`: `@shadcn/registry@0.1.3` strips it with a `g`-flagged regex
#   whose `lastIndex` the success path never resets (only its parse-failure branch
#   does), so which files keep the directive alternates with the order the run
#   processes them in. The line is inert here - `rsc: false`, and the app is one
#   bundled SPA, so nothing reads it - and a directive the CLI may or may not have
#   written is not a hand-edit.
#
# Needs the network (the registry and `pnpm dlx`).

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

names="$(basename -a -s .tsx src/components/ui/*.tsx | sort | tr '\n' ' ')"
if [ -z "${names// /}" ]; then
    echo "ui-check: no primitives under src/components/ui/" >&2
    exit 1
fi

# The version this repo's `src/components/ui/` was written with.
shadcn_version="4.21.4"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# A project the registry CLI can install into: the same manifest, aliases and
# stylesheet as the repo, and the repo's own node_modules.
cp components.json tsconfig.json package.json "$scratch/"
mkdir -p "$scratch/src" "$scratch/ours"
cp -r src/lib "$scratch/src/lib"
cp src/index.css "$scratch/src/index.css"
cp src/components/ui/*.tsx "$scratch/ours/"
ln -s "$root/node_modules" "$scratch/node_modules"

# shellcheck disable=SC2086
(cd "$scratch" && pnpm dlx "shadcn@${shadcn_version}" add $names --overwrite -y >/dev/null)

prettier="node_modules/.bin/prettier --config .prettierrc --write"
# shellcheck disable=SC2086
$prettier "$scratch/ours/"*.tsx >/dev/null
# shellcheck disable=SC2086
$prettier "$scratch/src/components/ui/"*.tsx >/dev/null

# Drop `"use client"` from the head of both trees (see the top of this file).
# The directive is always line 1, and the blank line under it is its own.
for dir in "$scratch/ours" "$scratch/src/components/ui"; do
    for file in "$dir"/*.tsx; do
        sed -i "1{/^['\"]use client['\"];*\$/d;}" "$file"
        sed -i '1{/^$/d;}' "$file"
    done
done

if diff -ru "$scratch/ours" "$scratch/src/components/ui"; then
    echo "ui-check: src/components/ui/ is the registry's own, unchanged"
else
    echo "ui-check: a file under src/components/ui/ was hand-edited." >&2
    echo "Put the difference where it belongs - a call site's className, the theme" >&2
    echo "in src/index.css, or a component of pie's own - and re-run this." >&2
    exit 1
fi
