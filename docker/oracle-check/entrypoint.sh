#!/bin/sh
# 점검 이미지 진입점: /check/target.json을 읽어 점검하고 /check/results에 보고서를 남긴다
set -eu

if [ ! -f "$QA_CHECK_TARGET" ]; then
  echo "설정 파일이 없습니다: $QA_CHECK_TARGET" >&2
  echo "target.json이 있는 폴더를 /check에 붙이세요. 예: docker run --rm -v \"\$PWD/check:/check\" <이미지>" >&2
  exit 2
fi

java -version 2>&1 | head -n 1
echo "Node $(node --version), 테스트베드 jar: $(ls "$QA_CHECK_TESTBED_JAR_DIR" | tr '\n' ' ')"

# --configLoader runner: 설정을 임시 파일로 번들하지 않는다(앱 폴더는 root 소유라 --user로 돌리면 쓸 수 없음)
exec ./node_modules/.bin/vitest run -c vitest.check.config.ts --configLoader runner "$@"
