# Tarefa: parser de precos

Implemente `parsePrice(input)` em `src/price.mjs`.

## Contrato

Recebe uma string com um preco e devolve o valor **em centavos** (inteiro).

## Regras

1. Aceita `R$` ou `US$` opcional no inicio, com ou sem espaco.
2. Aceita separador de milhar com ponto (`1.234,56`) e decimal com virgula.
3. Aceita formato com decimal por ponto quando nao houver virgula (`12.50`).
4. Ignora espacos no inicio e no fim.
5. **Lanca `Error`** para entrada vazia, `null`, `undefined` ou sem nenhum digito.
6. Nunca devolve `NaN`.

## Exemplos

| entrada | saida |
|---|---|
| `R$ 42,90` | `4290` |
| `42,90` | `4290` |
| `R$ 1.234,56` | `123456` |
| `US$ 12.50` | `1250` |
| `7` | `700` |

## Criterio de aceite

`run_tests` deve passar todos os testes de `test/price.test.mjs`.
