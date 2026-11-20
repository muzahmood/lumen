/** Worker helpers: ids, search queries, file names, the ciphertext shape check, Access settings parsing. */
import { describe, expect, it } from 'vitest';
import { normalizeTeamDomain, parseList, unverifiedSetupHint } from '../../worker/auth';
import { cleanSealed, ftsQuery, isCipher, isId, newId, parseSealed, safeFileName } from '../../worker/util';

describe('ids', () => {
  it('makes ids that pass the id check', () => {
    for (let i = 0; i < 200; i++) expect(isId(newId())).toBe(true);
    expect(isId('abc')).toBe(false);
    expect(isId('../etc/passwd')).toBe(false);
    expect(isId('a'.repeat(65))).toBe(false);
  });
});

describe('ftsQuery', () => {
  it('quotes every term as a prefix and drops FTS syntax', () => {
    expect(ftsQuery('hello world')).toBe('"hello"* "world"*');
    expect(ftsQuery('#tag "quoted" NEAR(a)')).toBe('"tag"* "quoted" "NEAR(a)"*');
    expect(ftsQuery('   ')).toBeNull();
    expect(ftsQuery('a b c d e f g h i j k l m n')!.split(' ')).toHaveLength(12);
  });

  it('reads "phrases" and words to leave out, but needs something to find', () => {
    expect(ftsQuery('budget "next  quarter" -draft -"old plan"')).toBe('"budget"* "next quarter" NOT "draft"* NOT "old plan"');
    expect(ftsQuery('"unclosed phr')).toBe('"unclosed phr"');
    expect(ftsQuery('-draft')).toBeNull();
    expect(ftsQuery('"" -')).toBeNull();
  });
});

describe('safeFileName', () => {
  it('keeps only safe characters', () => {
    expect(safeFileName('my photo (1).png')).toBe('my-photo-1.png');
    expect(safeFileName('../../x\\y"z.png')).not.toMatch(/[/\\"]/);
    expect(safeFileName('???')).toBe('file');
  });
});

describe('ciphertext shape', () => {
  const c = 'e1:' + 'A'.repeat(40);
  it('accepts the app’s format only', () => {
    expect(isCipher(c)).toBe(true);
    expect(isCipher('e1:short')).toBe(false);
    expect(isCipher('plain text')).toBe(false);
    expect(isCipher('e1:' + 'A'.repeat(40) + ' ')).toBe(false);
    expect(isCipher(c, 10)).toBe(false);
  });

  it('cleanSealed refuses plaintext and unknown fields', () => {
    expect(cleanSealed({ t: c, g: c, p: c })).toEqual({ t: c, g: c, p: c });
    expect(cleanSealed({ t: 'plain' })).toBeNull();
    expect(cleanSealed({ x: c })).toBeNull();
    expect(cleanSealed({ g: c }, ['t'])).toBeNull();
    expect(cleanSealed([c])).toBeNull();
  });

  it('parseSealed tolerates anything stored', () => {
    expect(parseSealed('{"t":"x"}')).toEqual({ t: 'x' });
    expect(parseSealed('not json')).toEqual({});
    expect(parseSealed('[1]')).toEqual({});
    expect(parseSealed(null)).toEqual({});
  });
});

describe('Access settings', () => {
  it('normalises the team domain and refuses anything else', () => {
    expect(normalizeTeamDomain('Team.CloudflareAccess.com/')).toBe('https://team.cloudflareaccess.com');
    expect(normalizeTeamDomain('https://evil.com')).toBeNull();
    expect(normalizeTeamDomain('https://a.cloudflareaccess.com.evil.com')).toBeNull();
    expect(normalizeTeamDomain('')).toBeNull();
  });

  it('parses comma or space separated lists', () => {
    expect(parseList(' a@x.com, b@x.com  c@x.com ,')).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(parseList(undefined)).toEqual([]);
  });

  it('only shows well-formed values on the setup page', () => {
    const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `x.${seg({ iss: 'https://t.cloudflareaccess.com', aud: ['a'.repeat(64), '<script>'], email: 'me@example.com' })}.y`;
    expect(unverifiedSetupHint(token)).toEqual({ team: 'https://t.cloudflareaccess.com', aud: ['a'.repeat(64)], email: 'me@example.com' });
    expect(unverifiedSetupHint('garbage')).toEqual({ team: null, aud: [], email: null });
    expect(unverifiedSetupHint(null)).toEqual({ team: null, aud: [], email: null });
  });

  it('suggests only a plain email address for the allow list', () => {
    const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const emailOf = (email: unknown) => unverifiedSetupHint(`x.${seg({ iss: 'https://t.cloudflareaccess.com', email })}.y`).email;
    expect(emailOf('First.Last+notes@mail.example.co.uk')).toBe('First.Last+notes@mail.example.co.uk');
    for (const bad of ['<b>@x.com', 'a"b@x.com', 'a b@x.com', 'a@x', 'a,b@x.com', 'a@<x>.com', 'a@x.com\n', 42, null, `${'a'.repeat(65)}@x.com`]) {
      expect(emailOf(bad)).toBeNull();
    }
  });
});
