// 실제 Quartz(2.3.2, 2.5.2)로 @qa/core 교차 검증 벡터를 만든다 (TRD §6.2).
//
//   docker build -t quartz-testbed:2.3.2 tools/quartz-testbed
//   docker build --build-arg QUARTZ_VERSION=2.5.2 -t quartz-testbed:2.5.2 tools/quartz-testbed
//   pnpm --filter @qa/core vectors
//
// 결과는 test/vectors/quartz.json에 커밋한다. CI는 Java 없이 이 파일과 비교한다.
// 기준은 2.3.2이고, 2.5.2 결과가 다르면 해당 항목에 `v252`로 남긴다. 두 버전이 다르게 계산하는 표현식은
// 도구가 지원하지 않는다(cron 검증에서 거부).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInput } from './vector-cases.mjs';

const VERSIONS = ['2.3.2', '2.5.2'];
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'test', 'vectors', 'quartz.json');

function run(version, input) {
  const image =
    process.env[`QA_TESTBED_IMAGE_${version.replaceAll('.', '_')}`] ?? `quartz-testbed:${version}`;
  const res = spawnSync('docker', ['run', '-i', '--rm', image, 'core-vectors'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`${image} 실행 실패 (exit ${res.status}): ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 비교에 쓰는 값만 남긴다. 2.3.2 기준 항목에 2.5.2가 다르면 v252를 붙인다 */
function merge(base, other, pick, keep) {
  return base.map((b, i) => {
    const o = other[i];
    const entry = keep(b);
    const bv = pick(b);
    const ov = pick(o);
    if (!same(bv, ov)) entry.v252 = ov;
    return entry;
  });
}

const input = buildInput();
const [a, b] = VERSIONS.map((v) => {
  process.stderr.write(`Quartz ${v} 벡터를 만드는 중...\n`);
  return run(v, input);
});

const cronPick = (r) =>
  r.error !== undefined
    ? { error: r.error }
    : r.runtimeError !== undefined
      ? { runtimeError: r.runtimeError }
      : { next: r.next };
const cronKeep = (r) => {
  const e = { id: r.id, cron: r.cron, timeZone: r.timeZone };
  if (r.from !== undefined) e.from = r.from;
  if (r.resolvedTimeZone !== r.timeZone) e.resolvedTimeZone = r.resolvedTimeZone;
  return Object.assign(e, cronPick(r));
};

const triggerPick = (r) =>
  r.error !== undefined
    ? { error: r.error }
    : r.runtimeError !== undefined
      ? { runtimeError: r.runtimeError }
      : {
          fireTimes: r.fireTimes,
          afterResults: r.afterResults,
          normalizedStartTime: r.normalizedStartTime,
        };
const RESULT_KEYS = new Set([
  'fireTimes',
  'afterResults',
  'normalizedStartTime',
  'error',
  'runtimeError',
]);
/** 입력 값은 그대로 두고 결과 값만 비교용으로 바꾼다 */
const triggerKeep = (r) => ({
  ...Object.fromEntries(Object.entries(r).filter(([k]) => !RESULT_KEYS.has(k))),
  ...triggerPick(r),
});

const vectors = {
  generatedBy: 'packages/core/scripts/generate-vectors.mjs',
  quartzVersions: VERSIONS,
  javaVersion: a.javaVersion,
  // CronExpression.MAX_YEAR(생성 시점 연도 + 100)에 따라 결과가 달라질 수 있어 남긴다
  generatedAt: new Date().toISOString().slice(0, 10),
  cron: merge(a.cron, b.cron, cronPick, cronKeep),
  cronTriggers: merge(a.cronTriggers, b.cronTriggers, triggerPick, triggerKeep),
  simpleTriggers: merge(a.simpleTriggers, b.simpleTriggers, triggerPick, triggerKeep),
  // 타임존과 properties는 Quartz가 아니라 JDK 동작이라 버전과 관계없다
  timeZones: a.timeZones,
  // JDK가 아는 모든 ID: [id, Java가 해석한 ID, ZoneId, 시점별 오프셋(ms)...]
  allTimeZonesAt: input.allTimeZonesAt,
  allTimeZones: a.allTimeZones.map((t) => [t.id, t.resolvedId, t.zoneId, ...t.offsets]),
  properties: a.properties,
};

/** 배열 항목 하나를 한 줄로 쓴다. diff를 읽기 쉽고 파일이 작다 */
function compact(obj) {
  const keys = Object.keys(obj);
  const lines = ['{'];
  keys.forEach((key, i) => {
    const value = obj[key];
    const tail = i === keys.length - 1 ? '' : ',';
    if (Array.isArray(value) && value.some((v) => typeof v === 'object')) {
      lines.push(`  ${JSON.stringify(key)}: [`);
      value.forEach((v, j) =>
        lines.push(`    ${JSON.stringify(v)}${j === value.length - 1 ? '' : ','}`),
      );
      lines.push(`  ]${tail}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${tail}`);
    }
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, compact(vectors));

// JDK의 타임존 ID 목록을 src/tz/java-zone-ids.ts로 만든다. java.util.TimeZone은 목록에 없는 ID를 GMT로 바꾼다
const ids = a.allTimeZones.map((t) => t.id);
const aliases = Object.fromEntries(
  a.allTimeZones.filter((t) => t.zoneId !== t.id).map((t) => [t.id, t.zoneId]),
);
writeFileSync(
  join(root, 'src', 'tz', 'java-zone-ids.ts'),
  `// scripts/generate-vectors.mjs가 만든다. 직접 고치지 않는다 (JDK ${a.javaVersion})\n\n` +
    `/** java.util.TimeZone.getAvailableIDs() */\n` +
    `export const JAVA_ZONE_IDS: readonly string[] = ${JSON.stringify(ids)};\n\n` +
    `/** TimeZone.toZoneId()가 다른 ID를 주는 것: 3글자 축약 ID(ZoneId.SHORT_IDS)와 고정 오프셋 */\n` +
    `export const JAVA_ZONE_ALIASES: Readonly<Record<string, string>> = ${JSON.stringify(aliases)};\n`,
);

const count = (list) => list.filter((e) => e.v252).length;
const combos = vectors.cron.filter((e) => e.id.startsWith('c') && e.next && !e.v252).length;
process.stderr.write(
  `완료: ${out}\n` +
    `  cron ${vectors.cron.length}건(두 버전이 같은 정상 조합 ${combos}), 2.5.2와 다른 결과 ${count(vectors.cron)}건\n` +
    `  CronTrigger ${vectors.cronTriggers.length}건(다름 ${count(vectors.cronTriggers)}), ` +
    `SimpleTrigger ${vectors.simpleTriggers.length}건(다름 ${count(vectors.simpleTriggers)})\n` +
    `  타임존 ${vectors.timeZones.length}건(JDK 전체 ID ${vectors.allTimeZones.length}개), ` +
    `properties ${vectors.properties.length}건\n`,
);
