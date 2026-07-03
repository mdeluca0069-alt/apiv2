export type PasswordValidationResult = {
  valid: boolean;
  errors: string[];
};

const MIN_LENGTH = 12;
const COMMON_PASSWORDS = new Set([
  "password", "password123", "123456789", "qwerty123", "iloveyou",
  "admin1234", "letmein1", "welcome1", "monkey123", "dragon123",
]);

export function validatePassword(plain: string): PasswordValidationResult {
  const errors: string[] = [];

  if (plain.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters.`);
  }
  if (!/[A-Z]/.test(plain)) {
    errors.push("Password must contain at least one uppercase letter.");
  }
  if (!/[a-z]/.test(plain)) {
    errors.push("Password must contain at least one lowercase letter.");
  }
  if (!/[0-9]/.test(plain)) {
    errors.push("Password must contain at least one digit.");
  }
  if (!/[^A-Za-z0-9]/.test(plain)) {
    errors.push("Password must contain at least one special character.");
  }
  if (/(.)\1{3,}/.test(plain)) {
    errors.push("Password must not contain four or more repeated characters in a row.");
  }
  if (COMMON_PASSWORDS.has(plain.toLowerCase())) {
    errors.push("Password is too common. Choose a more unique password.");
  }

  return { valid: errors.length === 0, errors };
}
