#!/bin/sh
# Publishes the current version as a GitHub release with the packed widget attached.
# Sites install it by URL: .../releases/download/v<version>/bubblesorted-feedback-widget-<version>.tgz
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
tag="v$version"
if [ -n "$(git status --porcelain)" ]; then echo "Commit your changes first." >&2; exit 1; fi
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then echo "$tag already exists: bump the version." >&2; exit 1; fi
npm run typecheck
npm test
npm run build
file=$(npm pack --silent)
git tag "$tag"
git push origin HEAD "$tag"
gh release create "$tag" "$file" --title "$tag" --notes "Install: npm install https://github.com/bubblesorted/feedback-widget/releases/download/$tag/$file"
rm -f "$file"
echo "Released $tag"
