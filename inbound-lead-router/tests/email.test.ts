import { describe, expect, it } from 'vitest';
import { domainFromInput, emailDomain, freeMailMatch, isFreeMailDomain } from '../src/lib/email';
import { FREE_EMAIL_DOMAINS } from '../src/lib/free-email-domains';

describe('free-mail detection', () => {
  it.each(['gmail.com', 'outlook.com', 'yahoo.co.uk', 'proton.me', 'mailinator.com', 'qq.com'])('%s is free-mail', (domain) => {
    expect(isFreeMailDomain(domain)).toBe(true);
  });

  it.each(['vercel.com', 'stripe.com', 'notgmail.com', 'gmail.company.com'])('%s is a company domain', (domain) => {
    expect(isFreeMailDomain(domain)).toBe(false);
  });

  it('matches subdomains of free-mail providers', () => {
    expect(freeMailMatch('mail.yahoo.com')).toBe('yahoo.com');
  });

  it('works on the normalized domain of an address', () => {
    expect(freeMailMatch(emailDomain('Someone@GMail.COM') ?? '')).toBe('gmail.com');
  });

  it('ships a list without duplicates or uppercase entries', () => {
    expect(new Set(FREE_EMAIL_DOMAINS).size).toBe(FREE_EMAIL_DOMAINS.length);
    expect(FREE_EMAIL_DOMAINS.every((domain) => domain === domain.toLowerCase())).toBe(true);
  });
});

describe('emailDomain', () => {
  it('extracts and normalizes the domain', () => {
    expect(emailDomain('demo@Vercel.com')).toBe('vercel.com');
    expect(emailDomain('first.last+tag@sub.example.co.uk')).toBe('sub.example.co.uk');
  });

  it.each(['no-at-sign', '@example.com', 'demo@', 'demo@localhost', 'de mo@example.com', 'demo@exa_mple.com'])('rejects %s', (value) => {
    expect(emailDomain(value)).toBeNull();
  });
});

describe('domainFromInput', () => {
  it.each([
    ['vercel.com', 'vercel.com'],
    ['  WWW.Vercel.com ', 'vercel.com'],
    ['https://vercel.com/pricing?x=1', 'vercel.com'],
    ['http://www.vercel.com:443/', 'vercel.com'],
    ['demo@vercel.com', 'vercel.com'],
    ['not a domain', null],
    ['', null],
  ])('%s -> %s', (input, expected) => {
    expect(domainFromInput(input)).toBe(expected);
  });
});
