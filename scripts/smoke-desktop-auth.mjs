import assert from 'node:assert/strict';

const { _test } = await import('../functions/desktop-auth/src/authPolicy.js');

const state = 'abcdefghijklmnop';
const verifier = 'qrstuvwxyzABCDEF';
const challenge = _test.sha256Base64Url(verifier);

assert.equal(_test.normalizeScheme('tantalum'), 'tantalum');
assert.equal(_test.normalizeScheme('tantalum-mobile'), 'tantalum-mobile');
assert.throws(() => _test.normalizeScheme('https'), /not allowed/);
assert.throws(() => _test.normalizeScheme('1bad'), /Invalid/);

assert.deepEqual(_test.validateGrantInput({
  state,
  codeChallenge: challenge,
  callbackScheme: 'tantalum-mobile',
}), {
  state,
  codeChallenge: challenge,
  callbackScheme: 'tantalum-mobile',
});

assert.deepEqual(_test.validateExchangeInput({
  grant: 'dg_1234567890abcdef1234567890abcdef1234',
  state,
  codeVerifier: verifier,
}), {
  grantId: 'dg_1234567890abcdef1234567890abcdef1234',
  state,
  codeVerifier: verifier,
});

console.log('Desktop/mobile auth smoke tests passed.');
