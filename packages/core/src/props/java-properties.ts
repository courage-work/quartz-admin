/**
 * `java.util.Properties.load()` 형식 파서 (TRD §6.1 `props`, §8.3).
 *
 * Quartz는 `useProperties=true`일 때 JobDataMap을 `Properties.store()`로 BLOB에 저장한다. 바이트는 ISO-8859-1이고
 * 그 밖의 문자는 `\uXXXX`로 이스케이프된다. 동작은 JDK 17 `Properties.LineReader`, `loadConvert`와 같다.
 *
 * - 줄 끝: `\n`, `\r`, `\r\n`. 줄 앞 공백(` `, `\t`, `\f`)은 버린다
 * - `#`, `!`로 시작하는 줄은 주석. 빈 줄은 건너뛴다
 * - 홀수 개의 `\`로 끝나는 줄은 다음 줄과 이어 붙이고, 다음 줄 앞 공백은 버린다
 * - 키는 이스케이프되지 않은 `=`, `:`, 공백에서 끝난다. 값 앞 공백과 구분자 하나를 건너뛴다
 * - 이스케이프: `\t`, `\n`, `\r`, `\f`, `\uXXXX`. 그 밖의 `\x`는 `x`
 */

export class JavaPropertiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JavaPropertiesError';
  }
}

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\f';
}

/** 논리적인 줄(이어 붙인 줄)을 차례로 돌려준다 */
function* logicalLines(text: string): Generator<string> {
  const n = text.length;
  let i = 0;
  while (i < n) {
    let line = '';
    let skipWhiteSpace = true;
    let isCommentLine = false;
    let isNewLine = true;
    let appendedLineBegin = false;
    let precedingBackslash = false;
    let skipLF = false;
    let ended = false;

    while (i < n) {
      const c = text[i++]!;
      if (skipLF) {
        skipLF = false;
        if (c === '\n') continue;
      }
      if (skipWhiteSpace) {
        if (isWhitespace(c)) continue;
        if (!appendedLineBegin && (c === '\r' || c === '\n')) continue;
        skipWhiteSpace = false;
        appendedLineBegin = false;
      }
      if (isNewLine) {
        isNewLine = false;
        if (c === '#' || c === '!') {
          isCommentLine = true;
          continue;
        }
      }
      if (c !== '\n' && c !== '\r') {
        if (isCommentLine) continue;
        line += c;
        precedingBackslash = c === '\\' ? !precedingBackslash : false;
        continue;
      }
      // 줄 끝
      if (isCommentLine || line.length === 0) {
        isCommentLine = false;
        isNewLine = true;
        skipWhiteSpace = true;
        line = '';
        if (c === '\r') skipLF = true;
        continue;
      }
      if (precedingBackslash) {
        line = line.slice(0, -1);
        skipWhiteSpace = true;
        appendedLineBegin = true;
        precedingBackslash = false;
        if (c === '\r') skipLF = true;
        continue;
      }
      if (c === '\r' && text[i] === '\n') i++;
      ended = true;
      break;
    }
    if (!ended) {
      // 파일 끝. 주석이거나 비어 있으면 버리고, 끝의 `\` 하나는 지운다
      if (isCommentLine || line.length === 0) return;
      if (precedingBackslash) line = line.slice(0, -1);
    }
    yield line;
  }
}

function loadConvert(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    let c = s[i++]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    if (i >= s.length) break;
    c = s[i++]!;
    if (c === 'u') {
      if (i + 4 > s.length) throw new JavaPropertiesError('Malformed \\uxxxx encoding.');
      const hex = s.slice(i, i + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex))
        throw new JavaPropertiesError('Malformed \\uxxxx encoding.');
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else if (c === 't') out += '\t';
    else if (c === 'r') out += '\r';
    else if (c === 'n') out += '\n';
    else if (c === 'f') out += '\f';
    else out += c;
  }
  return out;
}

/**
 * properties 텍스트(ISO-8859-1로 디코드한 문자열)를 파싱한다. 같은 키가 여러 번 나오면 마지막 값이 남는다.
 * @throws JavaPropertiesError 잘못된 `\uXXXX`
 */
export function parseJavaProperties(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of logicalLines(text)) {
    const limit = line.length;
    let keyLen = 0;
    let valueStart = limit;
    let hasSep = false;
    let precedingBackslash = false;
    while (keyLen < limit) {
      const c = line[keyLen]!;
      if ((c === '=' || c === ':') && !precedingBackslash) {
        valueStart = keyLen + 1;
        hasSep = true;
        break;
      } else if (isWhitespace(c) && !precedingBackslash) {
        valueStart = keyLen + 1;
        break;
      }
      precedingBackslash = c === '\\' ? !precedingBackslash : false;
      keyLen++;
    }
    while (valueStart < limit) {
      const c = line[valueStart]!;
      if (!isWhitespace(c)) {
        if (!hasSep && (c === '=' || c === ':')) hasSep = true;
        else break;
      }
      valueStart++;
    }
    result.set(loadConvert(line.slice(0, keyLen)), loadConvert(line.slice(valueStart, limit)));
  }
  return result;
}

/** BLOB 바이트(ISO-8859-1)를 파싱한다 */
export function parseJavaPropertiesBytes(bytes: Uint8Array): Map<string, string> {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return parseJavaProperties(text);
}
