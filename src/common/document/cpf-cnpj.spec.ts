import { isValidCnpj, isValidCpf, isValidCpfOrCnpj } from './cpf-cnpj';

describe('cpf-cnpj', () => {
  it('aceita CPF e CNPJ validos, com ou sem pontuacao', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCpfOrCnpj('52998224725')).toBe(true);
  });

  it('recusa digitos verificadores errados, repetidos e tamanho errado', () => {
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpfOrCnpj('123')).toBe(false);
  });
});
