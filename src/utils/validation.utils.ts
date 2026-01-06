/**
 * Utilitários para validação de dados
 */
export class ValidationUtils {
  /**
   * Verifica se uma string é um número de telefone válido
   */
  static isValidPhoneNumber(phone: string): boolean {
    // Remove caracteres não numéricos
    const cleaned = phone.replace(/\D/g, "");
    // Valida se tem entre 10 e 15 dígitos
    return cleaned.length >= 10 && cleaned.length <= 15;
  }

  /**
   * Verifica se é uma string base64 válida de imagem
   */
  static isValidBase64Image(str: string): boolean {
    return /^data:image\/[a-zA-Z]+;base64,/.test(str);
  }

  /**
   * Verifica se é um token válido
   */
  static isValidToken(token: string): boolean {
    return typeof token === "string" && token.trim().length > 0;
  }

  /**
   * Normaliza número de telefone
   */
  static normalizePhoneNumber(phone: string): string {
    return phone.replace(/\D/g, "");
  }
}
