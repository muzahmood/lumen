/**
 * Laying out JSON for a code block's Format button (src/lib/utils.ts): two-space indents as
 * JSON.stringify gives, but keys, strings and numbers kept exactly as written.
 */
import { describe, expect, it } from 'vitest';
import { formatJson } from '../../src/lib/utils';

describe('formatJson', () => {
  it('lays JSON out as JSON.stringify(value, null, 2) does', () => {
    const src = '{"a":1,"b":[true,null,{"c":"x"}],"d":{},"e":[ ],"f":-2.5}';
    expect(formatJson(src)).toBe(JSON.stringify(JSON.parse(src), null, 2));
  });

  it('keeps keys in their order, repeated keys, and numbers exactly as written', () => {
    expect(formatJson('{"b":1,"10":2,"2":3,"a":1,"a":2,"big":12345678901234567890,"f":1.0,"e":1E3}')).toBe(
      ['{', '  "b": 1,', '  "10": 2,', '  "2": 3,', '  "a": 1,', '  "a": 2,', '  "big": 12345678901234567890,', '  "f": 1.0,', '  "e": 1E3', '}'].join('\n'),
    );
  });

  it('leaves strings alone, punctuation and escapes included', () => {
    const s = String.raw`"a, b: {c} [d] \"q\" \\ é ✓"`;
    expect(formatJson(`{"s":${s}}`)).toBe(`{\n  "s": ${s}\n}`);
  });

  it('tidies any layout, and changes nothing the second time', () => {
    const once = formatJson('{\n\t"a" :\r\n 1 ,"b":[ 1 ,\n2]}')!;
    expect(once).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(formatJson(once)).toBe(once);
  });

  it('handles a lone value', () => {
    expect(formatJson('  42 ')).toBe('42');
    expect(formatJson('"x"')).toBe('"x"');
    expect(formatJson('[]')).toBe('[]');
  });

  it('turns down anything that isn’t JSON', () => {
    for (const bad of ['', '{"a":1,}', '{a:1}', '// note\n{}', "{'a':1}", '{"a":1} {"b":2}', '[1, 2']) {
      expect(formatJson(bad), bad).toBeNull();
    }
  });
});
