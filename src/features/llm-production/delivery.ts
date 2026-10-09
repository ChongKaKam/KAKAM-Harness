import { z } from 'zod';
import { productionLimits } from './types';

export const productionFormats = [
  'text',
  'markdown',
  'json',
  'csv',
  'html',
  'svg',
  'pdf',
  'docx',
  'xlsx',
  'pptx',
] as const;

export const productionFilename = z
  .string()
  .trim()
  .min(1)
  .max(175)
  .refine(
    (value) => !/[\x00-\x1f\x7f/\\]/.test(value) && !['.', '..'].includes(value),
    '文件名无效',
  );

const deliveryItemInput = z
  .object({
    kind: z.enum(['file', 'image']),
    format: z.enum(productionFormats).nullable(),
    name: productionFilename,
    brief: z.string().trim().min(1).max(16_000),
  })
  .strict()
  .refine((item) => item.kind !== 'image' || item.format === null, '图片格式由生成模型决定');

export const productionPlanInput = z
  .object({
    decision: z.enum(['deliver', 'clarify']),
    items: z.array(deliveryItemInput).max(productionLimits.deliveryItems),
    question: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.decision === 'deliver' && (!plan.items.length || plan.question !== null))
      context.addIssue({ code: 'custom', message: '交付计划必须包含产物，且不能同时要求澄清' });
    if (plan.decision === 'clarify' && (plan.items.length || !plan.question))
      context.addIssue({ code: 'custom', message: '澄清计划必须只包含问题' });
  });

export type ProductionPlanInput = z.infer<typeof productionPlanInput>;

export const storedProductionPlan = z.object({
  decision: z.enum(['deliver', 'clarify']),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        kind: z.enum(['file', 'image']),
        format: z.enum(productionFormats).nullable(),
        name: productionFilename,
        brief: z.string(),
        status: z.enum(['pending', 'complete', 'failed']),
        error: z.string().optional(),
      }),
    )
    .max(productionLimits.deliveryItems),
  question: z.string().optional(),
});

export function planIdentity(plan: ProductionPlanInput | z.infer<typeof storedProductionPlan>) {
  return JSON.stringify({
    decision: plan.decision,
    items: plan.items.map(({ kind, format, name, brief }) => ({ kind, format, name, brief })),
    question: plan.question ?? null,
  });
}

export const productionImageMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];
