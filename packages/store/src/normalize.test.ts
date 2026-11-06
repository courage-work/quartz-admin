import { describe, expect, it } from 'vitest';
import { readBlob, readBool, readLong, readString, readTime } from './normalize.js';

describe('readLong', () => {
  it('NULL만 null이고 음수와 0은 그대로 둔다', () => {
    expect(readLong(null)).toBeNull();
    expect(readLong(undefined)).toBeNull();
    expect(readLong(-1)).toBe(-1);
    expect(readLong(0)).toBe(0);
    expect(readLong(1_762_400_000_000)).toBe(1_762_400_000_000);
  });

  it('bigint와 정수 문자열을 숫자로 바꾼다', () => {
    expect(readLong(42n)).toBe(42);
    expect(readLong(' 7 ')).toBe(7);
    expect(readLong('-3')).toBe(-3);
    expect(readLong('5.0')).toBe(5);
  });

  it('정수가 아니거나 안전 범위를 벗어나면 던진다', () => {
    expect(() => readLong('abc')).toThrow(TypeError);
    expect(() => readLong('1.5')).toThrow(TypeError);
    expect(() => readLong(2n ** 60n)).toThrow(RangeError);
    expect(() => readLong({})).toThrow(TypeError);
  });
});

describe('readTime', () => {
  it('NULL, -1, 0을 모두 null로 본다 (TRD §5.4)', () => {
    expect(readTime(null)).toBeNull();
    expect(readTime(-1)).toBeNull();
    expect(readTime(0)).toBeNull();
    expect(readTime(1_762_400_000_000)).toBe(1_762_400_000_000);
  });
});

describe('readBool', () => {
  it.each([
    ['1', true],
    ['0', false],
    ['Y', true],
    ['n', false],
    ['T', true],
    ['F', false],
    ['true', true],
    ['1 ', true],
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    [Buffer.from([1]), true],
    [Buffer.from([0]), false],
  ])('%j → %s', (input, expected) => {
    expect(readBool(input)).toBe(expected);
  });

  it('NULL과 알아볼 수 없는 값은 null', () => {
    expect(readBool(null)).toBeNull();
    expect(readBool('X')).toBeNull();
    expect(readBool(2)).toBeNull();
  });
});

describe('readBlob', () => {
  it('Buffer와 Uint8Array를 Buffer로 받고, 빈 값은 null', () => {
    expect(readBlob(Buffer.from('ab'))).toEqual(Buffer.from('ab'));
    expect(readBlob(new Uint8Array([1, 2]))).toEqual(Buffer.from([1, 2]));
    expect(readBlob(Buffer.alloc(0))).toBeNull();
    expect(readBlob(null)).toBeNull();
    expect(() => readBlob('ab')).toThrow(TypeError);
  });
});

describe('readString', () => {
  it('빈 문자열을 NULL과 같게 본다 (Oracle)', () => {
    expect(readString('')).toBeNull();
    expect(readString(null)).toBeNull();
    expect(readString('desc')).toBe('desc');
  });
});
