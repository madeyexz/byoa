#!/usr/bin/env bash
# Model-checks the TLA+ specs in this folder with TLC (spec/tla/README.md). Each model in models/ is
# <Spec>_<name>.cfg, and its first line says what TLC must find: `\* expect: ok`, or `\* expect: violated <Property>`
# (a model of the code as it was before a fix, kept so the fix stays needed). Run: spec/tla/check.sh [pattern]
# Needs Java 11 or later; downloads tla2tools.jar (pinned, checked by its SHA-256) into spec/tla/.tools the first time.
set -euo pipefail
cd "$(dirname "$0")"
TLA_VERSION=1.7.4
JAR=.tools/tla2tools-$TLA_VERSION.jar
SHA=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
if [ ! -f "$JAR" ]; then
  mkdir -p .tools
  curl -fsSL -o "$JAR.part" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
  echo "$SHA  $JAR.part" | sha256sum -c - >/dev/null
  mv "$JAR.part" "$JAR"
fi
JAVA=${JAVA:-java}
fail=0
for cfg in models/*${1:-}*.cfg; do
  spec=$(basename "$cfg" .cfg); spec=${spec%%_*}
  expect=$(head -1 "$cfg" | sed -n 's/^\\\* expect: //p')
  out=$("$JAVA" -XX:+UseParallelGC -Xmx${TLC_HEAP:-2g} -cp "$JAR" tlc2.TLC -deadlock -workers auto \
    -metadir "$(mktemp -d)" -config "$cfg" "$spec.tla" 2>&1) || true
  if grep -q 'Model checking completed. No error has been found' <<<"$out"; then got=ok
  else got="violated $(sed -n 's/^Error: \(Invariant\|Temporal property\|Action property\) \([A-Za-z0-9_]*\) is violated.*/\2/p' <<<"$out" | head -1)"
  fi
  states=$(sed -n 's/^\([0-9,]*\) states generated.*/\1/p' <<<"$out" | tail -1)
  if [ "$got" = "$expect" ]; then echo "ok    $cfg: $got ($states states)"
  else
    echo "FAIL  $cfg: expected \"$expect\", TLC found \"$got\""
    grep -E '^(Error|State [0-9]+:)' <<<"$out" | head -40
    fail=1
  fi
done
exit $fail
