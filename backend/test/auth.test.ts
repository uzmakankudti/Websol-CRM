import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  generateResetToken,
  hashToken,
} from '../src/shared/auth';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const stored = hashPassword('S3cret!pw');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('S3cret!pw', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('produces a different salt/hash each time', () => {
    expect(hashPassword('same')).not.toEqual(hashPassword('same'));
  });

  it('rejects a malformed stored hash without throwing', () => {
    expect(verifyPassword('x', 'not-a-real-hash')).toBe(false);
  });
});

describe('JWT', () => {
  const base = { sub: 7, email: 'a@b.com', role: 'SYSTEM_ADMIN', perms: ['users.read'] };

  it('round-trips a valid token', () => {
    const token = issueToken(base);
    const payload = verifyToken(token);
    expect(payload?.sub).toBe(7);
    expect(payload?.perms).toContain('users.read');
  });

  it('rejects a tampered token', () => {
    const token = issueToken(base);
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa');
    expect(verifyToken(tampered)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = issueToken(base, -1); // already expired
    expect(verifyToken(token)).toBeNull();
  });

  it('rejects a garbage token', () => {
    expect(verifyToken('not.a.jwt')).toBeNull();
  });
});

describe('reset tokens', () => {
  it('hashes deterministically and the hash differs from the token', () => {
    const { token, tokenHash } = generateResetToken();
    expect(tokenHash).toHaveLength(64);
    expect(tokenHash).not.toEqual(token);
    expect(hashToken(token)).toEqual(tokenHash);
  });
});
