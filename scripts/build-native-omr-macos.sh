#!/usr/bin/env bash
set -euo pipefail

# Builds the private OMR worker used by the signed desktop package. It is not
# committed: Audiveris is downloaded from its official release on each build.
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
architecture="$(uname -m)"
case "$architecture" in
  arm64) audiveris_arch="arm64" ;;
  x86_64) audiveris_arch="x86_64" ;;
  *) echo "Unsupported macOS architecture: $architecture" >&2; exit 1 ;;
esac

target_dir="$project_dir/desktop/native/darwin-$audiveris_arch"
build_dir="${TMPDIR:-/tmp}/notera-native-omr-$audiveris_arch"
venv_dir="$build_dir/venv"
audiveris_dmg="$build_dir/Audiveris-5.10.2-macosx-$audiveris_arch.dmg"

mkdir -p "$target_dir" "$build_dir"
python3 -m venv "$venv_dir"
"$venv_dir/bin/pip" install --disable-pip-version-check -r "$project_dir/omr-service/requirements.txt" pyinstaller
"$venv_dir/bin/pyinstaller" --noconfirm --clean --onefile --name notera-omr \
  --collect-all fastapi --collect-all pydantic --collect-all pypdf --collect-all pymupdf --collect-all fitz --collect-all uvicorn \
  --distpath "$target_dir" --workpath "$build_dir/work" --specpath "$build_dir/spec" \
  "$project_dir/omr-service/app/main.py"

curl --fail --location --retry 3 \
  "https://github.com/Audiveris/audiveris/releases/download/5.10.2/Audiveris-5.10.2-macosx-$audiveris_arch.dmg" \
  --output "$audiveris_dmg"
mount_point="$build_dir/audiveris-mount"
mkdir -p "$mount_point"
# The official DMG has an interactive licence prompt. Feed its affirmative
# answer and use a fixed non-GUI mount point so the same command works in CI.
printf 'Y\n' | hdiutil attach -nobrowse -readonly -noverify -mountpoint "$mount_point" "$audiveris_dmg"
if [[ ! -d "$mount_point/Audiveris.app" ]]; then
  echo "Could not mount the official Audiveris DMG." >&2
  exit 1
fi
trap 'hdiutil detach "$mount_point" -quiet || true' EXIT
cp -R "$mount_point/Audiveris.app" "$target_dir/Audiveris.app"
