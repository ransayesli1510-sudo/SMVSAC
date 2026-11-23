import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().email('Informe um e-mail válido.'),
  password: z.string().min(1, 'Informe sua senha.'),
});

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'O nome deve ter pelo menos 2 caracteres.').max(120),
  email: z.string().trim().email('Informe um e-mail válido.'),
  password: z
    .string()
    .min(6, 'A senha deve ter pelo menos 6 caracteres.')
    .max(128),
  organizationSlug: z.string().trim().min(2).max(80).optional(),
});

export const refreshSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
  })
  .optional();

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Informe um e-mail válido.'),
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(16, 'Token de recuperação inválido.'),
  newPassword: z
    .string()
    .min(6, 'A nova senha deve ter pelo menos 6 caracteres.')
    .max(128),
});

export const updateAvailabilitySchema = z.object({
  availability: z.enum(['ONLINE', 'BUSY', 'OFFLINE']),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UpdateAvailabilityInput = z.infer<typeof updateAvailabilitySchema>;
