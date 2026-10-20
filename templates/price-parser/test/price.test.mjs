import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice } from '../src/price.mjs';

test('formato brasileiro com simbolo', () => {
  assert.equal(parsePrice('R$ 42,90'), 4290);
});

test('formato brasileiro sem simbolo', () => {
  assert.equal(parsePrice('42,90'), 4290);
});

test('separador de milhar', () => {
  assert.equal(parsePrice('R$ 1.234,56'), 123456);
});

test('formato com decimal por ponto', () => {
  assert.equal(parsePrice('US$ 12.50'), 1250);
});

test('inteiro sem decimais', () => {
  assert.equal(parsePrice('7'), 700);
});

test('espacos em volta', () => {
  assert.equal(parsePrice('  15,00  '), 1500);
});

test('entrada vazia lanca erro', () => {
  assert.throws(() => parsePrice(''));
});

test('entrada sem digitos lanca erro', () => {
  assert.throws(() => parsePrice('R$'));
});

test('nunca devolve NaN', () => {
  const out = parsePrice('R$ 3,99');
  assert.ok(Number.isInteger(out));
});
