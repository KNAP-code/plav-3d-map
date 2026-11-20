#!/usr/bin/env bash
# Build a static export that can be hosted from any sub-path and from hosts that
# reserve names starting with "_": renames out/_next -> out/nxt and rewrites references.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf out
ASSET_PREFIX=. NEXT_TELEMETRY_DISABLED=1 npx next build
mv out/_next out/nxt
grep -rl "_next/" out --include=*.html --include=*.js --include=*.css --include=*.txt | xargs sed -i 's#_next/#nxt/#g'
rm -rf out/_not-found out/404 out/404.html out/*.txt
echo "preview export ready in out/"
# Some static hosts only serve standard web types: ship the binary grids as .wasm (application/wasm, byte-exact).
for d in out/data/*/; do
  for f in "$d"*.bin; do mv "$f" "${f%.bin}.wasm"; done
  python3 - "$d/meta.json" <<'PY'
import json, sys
p = sys.argv[1]; m = json.load(open(p))
m["core"]["file"] = m["core"]["file"].replace(".bin", ".wasm")
m["context"]["file"] = m["context"]["file"].replace(".bin", ".wasm")
m["treesFile"] = "trees.wasm"
json.dump(m, open(p, "w"), ensure_ascii=False, indent=1)
PY
done
echo "binary grids renamed to .wasm"
# Drop the legacy noModule polyfill bundle (ignored by every browser that runs WebGL2 modules;
# it also contains raw U+FFFD bytes some hosts reject).
for f in out/nxt/static/chunks/*.js; do
  if python3 -c "import sys; sys.exit(0 if '�' in open(sys.argv[1], encoding='utf-8').read() else 1)" "$f"; then
    b=$(basename "$f"); rm "$f"
    sed -i "s#<script src=\"./nxt/static/chunks/$b\" noModule=\"\"></script>##g" out/index.html
    echo "removed noModule bundle $b"
  fi
done
