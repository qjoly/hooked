import { describe, it, expect } from 'vitest';
import { authorizeRemote, isLoopbackAddress } from '../server/remoteAuth.js';

const T = 'secret-token';
const remote = (extra) => authorizeRemote({ addr: '192.168.1.20', ...extra }, T);

describe('authorizeRemote', () => {
  it('lets loopback through without a token', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(authorizeRemote({ addr }, T)).toBe('ok');
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });

  it('denies a remote request without a valid token', () => {
    expect(remote({})).toBe('deny');
    expect(remote({ authorization: 'Bearer nope' })).toBe('deny');
    expect(remote({ authorization: 'Bearer ' })).toBe('deny');
    expect(authorizeRemote({ addr: null }, T)).toBe('deny');
  });

  it('accepts the bearer header or the cookie', () => {
    expect(remote({ authorization: `Bearer ${T}` })).toBe('ok');
    expect(remote({ cookie: `a=b; hooked_token=${T}` })).toBe('ok');
  });

  it('asks to pair on a valid ?token=', () => {
    expect(remote({ queryToken: T })).toBe('pair');
    expect(remote({ queryToken: 'x' })).toBe('deny');
  });
});
