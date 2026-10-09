#!/usr/bin/env bash
# Regenerates fixtures/synthea (10 synthetic patients, FHIR R4 + C-CDA).
# Requires Java 17+. Output is deterministic for a given jar + seed + reference date.
set -euo pipefail

JAR_URL="https://github.com/synthetichealth/synthea/releases/download/master-branch-latest/synthea-with-dependencies.jar"
JAR_SHA256="018ad7f04f7aacb995804d7d4781c76d5fc714f7f23257ba50daa9eefae224ac"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${SYNTHEA_WORKDIR:-$ROOT/tmp/synthea}"
JAR="$WORK/synthea-with-dependencies.jar"

mkdir -p "$WORK"
[ -f "$JAR" ] || curl -fsSL -o "$JAR" "$JAR_URL"
if ! echo "$JAR_SHA256  $JAR" | sha256sum -c --quiet -; then
  echo "Synthea jar checksum changed; update JAR_SHA256 deliberately if you want the new build." >&2
  exit 1
fi

rm -rf "$WORK/output"
# UTF-8 flags: without them, patients with non-ASCII names fail to export.
LC_ALL=C.UTF-8 java -Dsun.jnu.encoding=UTF-8 -Dfile.encoding=UTF-8 -jar "$JAR" \
  -p 10 -s 3 -cs 3 -r 20260101 \
  --exporter.baseDirectory "$WORK/output" \
  --exporter.years_of_history 3 \
  --exporter.fhir.export true \
  --exporter.ccda.export true \
  --exporter.csv.export false \
  --generate.only_alive_patients true \
  Massachusetts

rm -rf "$ROOT/fixtures/synthea/fhir" "$ROOT/fixtures/synthea/ccda"
mkdir -p "$ROOT/fixtures/synthea"
cp -r "$WORK/output/fhir" "$WORK/output/ccda" "$ROOT/fixtures/synthea/"
echo "fixtures/synthea: $(ls "$ROOT/fixtures/synthea/fhir" | grep -vc Information) patients"
