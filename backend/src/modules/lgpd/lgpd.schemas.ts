import { z } from 'zod';

export const recordConsentSchema = z.object({
  termVersion: z.string().trim().min(1).max(40).default('1.0.0'),
  acceptedRequired: z.literal(true, {
    errorMap: () => ({
      message: 'O aceite do termo obrigatório é necessário para registrar o consentimento.',
    }),
  }),
  acceptedMarketing: z.boolean().default(false),
  subjectType: z.enum(['USER', 'CONTACT']).default('USER'),
  subjectId: z.string().uuid('subjectId deve ser um UUID válido.').optional(),
});

export const revokeConsentSchema = z.object({
  termVersion: z.string().trim().min(1).max(40).default('1.0.0'),
  subjectType: z.enum(['USER', 'CONTACT']).default('USER'),
  subjectId: z.string().uuid('subjectId deve ser um UUID válido.').optional(),
});

export const exportDataQuerySchema = z.object({
  contactId: z.string().uuid('contactId deve ser um UUID válido.').optional(),
});

export const anonymizeSchema = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('self'),
    currentPassword: z.string().min(1, 'Informe sua senha atual para confirmar a anonimização.'),
    confirm: z.literal('ANONIMIZAR', {
      errorMap: () => ({ message: 'Envie confirm: "ANONIMIZAR" para confirmar a operação irreversível.' }),
    }),
  }),
  z.object({
    target: z.literal('contact'),
    contactId: z.string().uuid('contactId deve ser um UUID válido.'),
    confirm: z.literal('ANONIMIZAR', {
      errorMap: () => ({ message: 'Envie confirm: "ANONIMIZAR" para confirmar a operação irreversível.' }),
    }),
  }),
]);

export type RecordConsentInput = z.infer<typeof recordConsentSchema>;
export type RevokeConsentInput = z.infer<typeof revokeConsentSchema>;
export type ExportDataQuery = z.infer<typeof exportDataQuerySchema>;
export type AnonymizeInput = z.infer<typeof anonymizeSchema>;
