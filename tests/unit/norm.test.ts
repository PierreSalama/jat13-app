import { describe, it, expect } from 'vitest';
import { normKey, normJobUrl, normQuestion } from '../../shared/src/norm.js';

describe('normKey', () => {
  it('lowercases and collapses non-alphanumerics', () => {
    expect(normKey('Acme Corp. (Canada)')).toBe('acme corp canada');
    expect(normKey('  Lever.co  ')).toBe('lever co');
    expect(normKey(null)).toBe('');
  });
});

describe('normJobUrl', () => {
  it('drops trailing slash + junk query, lowercases, keeps id params', () => {
    expect(normJobUrl('https://www.LinkedIn.com/jobs/view/123/?refId=x&trk=y'))
      .toBe('https://www.linkedin.com/jobs/view/123');
    expect(normJobUrl('https://ca.indeed.com/viewjob?jk=abc123&from=serp&tk=z'))
      .toBe('https://ca.indeed.com/viewjob?jk=abc123');
    expect(normJobUrl('boards.greenhouse.io/stripe/jobs/456'))
      .toBe('boards.greenhouse.io/stripe/jobs/456');
  });
  it('two URLs for the same posting normalize equal (dedup key)', () => {
    const a = normJobUrl('https://www.linkedin.com/jobs/view/999?refId=A');
    const b = normJobUrl('https://www.linkedin.com/jobs/view/999/?trk=B&refId=C');
    expect(a).toBe(b);
  });
});

describe('normQuestion (ask-once-ever key)', () => {
  it('is word-order invariant (bag of words, sorted)', () => {
    expect(normQuestion('years experience')).toBe(normQuestion('experience years'));
  });
  it('drops filler words', () => {
    expect(normQuestion('How many years of experience do you have?'))
      .toBe(normQuestion('years experience'));
  });
  it('canonicalizes FR->EN tokens (annees -> years, accents folded)', () => {
    expect(normQuestion('années expérience')).toBe(normQuestion('years experience'));
  });
  it('empty is empty', () => {
    expect(normQuestion('')).toBe('');
  });
});
