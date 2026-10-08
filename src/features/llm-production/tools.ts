import type { Context } from 'cordis';
import { z } from 'zod';
import { HttpError } from '../../kernel/http';
import type { ToolDefinition } from '../../adapters/registry';
import { renderProduction } from './generators';
import { productionLimits, type ProductionArtifact } from './types';

const formats = [
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
const filename = z
  .string()
  .trim()
  .min(1)
  .max(175)
  .refine(
    (value) => !/[\x00-\x1f\x7f/\\]/.test(value) && !['.', '..'].includes(value),
    '文件名无效',
  );
const fileInput = z
  .object({
    name: filename,
    format: z.enum(formats),
    content: z.string().min(1).max(productionLimits.textCharacters),
  })
  .strict();
const imageInput = z
  .object({
    name: filename,
    prompt: z.string().trim().min(1).max(16_000),
  })
  .strict();

function result(artifact: ProductionArtifact) {
  return JSON.stringify({
    id: artifact.id,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    space: artifact.spaceName,
    expiresAt: artifact.expiresAt,
    downloadUrl: `/api/llm-production/artifacts/${artifact.id}/download`,
  });
}

export function registerProductionTools(ctx: Context) {
  return ctx.extensions.registerConversationTools({
    id: 'llm-production',
    instructions:
      "Production tools can create downloadable files in this conversation's private artifact space, shared with its group when grouped. Use them when the user requests actual files or images. Only claim an artifact was created after a successful tool result; use the returned download URL. Never invent file URLs. Document generation uses fixed renderers, not script execution. Existing group artifacts remain shared when a source conversation moves or is deleted.",
    tools(user) {
      const preferences = ctx.production.preferences(user.id);
      if (!preferences.enabled) return [];
      const tools: ToolDefinition[] = [
        {
          name: 'production_create_file',
          description:
            'Create a downloadable file. text/markdown/json/csv/html/svg take UTF-8 contents; PDF and DOCX take plain text with paragraphs. XLSX content is JSON {"sheets":[{"name":"Sheet1","rows":[["Name","Value"],["Example",12]]}]}; cells must be strings, numbers, booleans or null. PPTX content is JSON {"slides":[{"title":"Title","body":["Point one","Point two"]}]}. Files are stored only after successful rendering. HTML/SVG are download-only, never executed in chat.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'User-facing filename, including the appropriate extension.',
              },
              format: { type: 'string', enum: [...formats] },
              content: {
                type: 'string',
                description:
                  'File contents or serialized document JSON. Maximum 500000 characters.',
              },
            },
            required: ['name', 'format', 'content'],
            additionalProperties: false,
          },
        },
      ];
      if (preferences.imageModelId) {
        try {
          ctx.models.authorize(user, preferences.imageModelId, 'image');
          tools.push({
            name: 'production_generate_image',
            description:
              'Generate an image with the user-selected image model and save it to the artifact space. Provide a descriptive image prompt and filename. The result contains the real downloadable artifact metadata.',
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                prompt: { type: 'string' },
              },
              required: ['name', 'prompt'],
              additionalProperties: false,
            },
          });
        } catch {
          /* A revoked model is omitted; file tools remain available. */
        }
      }
      return tools;
    },
    async execute(scope, call) {
      const key = `${scope.messageId}:${scope.requestId}:${call.id}`;
      const existing = ctx.production.findCreated(scope.user.id, key);
      if (existing) return result(existing);
      try {
        const scopeInput = {
          conversationId: scope.conversationId,
          messageId: scope.messageId,
          idempotencyKey: key,
        };
        if (call.name === 'production_create_file') {
          const parsed = fileInput.safeParse(call.arguments);
          if (!parsed.success) throw new HttpError(400, '文件参数无效，请核对文件名、格式与内容');
          const file = await renderProduction(parsed.data);
          scope.signal.throwIfAborted();
          return result(
            ctx.production.create(scope.user, { ...scopeInput, ...file }, scope.signal),
          );
        }
        if (call.name === 'production_generate_image') {
          const parsed = imageInput.safeParse(call.arguments);
          if (!parsed.success) throw new HttpError(400, '图片参数无效，请提供文件名和描述');
          const modelId = ctx.production.preferences(scope.user.id).imageModelId;
          if (!modelId) throw new HttpError(400, '请先在产物空间设置中选择图片生成模型');
          const storage = ctx.production.storage(scope.user.id);
          if (storage.usedBytes >= storage.limitBytes)
            throw new HttpError(400, '产物空间已满，请删除部分文件后重试');
          const image = await ctx.models.generateImage(
            scope.user,
            modelId,
            parsed.data.prompt,
            scope.signal,
          );
          scope.signal.throwIfAborted();
          const extension =
            image.mimeType === 'image/jpeg'
              ? 'jpg'
              : image.mimeType === 'image/webp'
                ? 'webp'
                : 'png';
          const name = parsed.data.name.replace(/\.[a-z0-9]+$/i, '') + '.' + extension;
          return result(
            ctx.production.create(
              scope.user,
              { ...scopeInput, name, mimeType: image.mimeType, data: image.data },
              scope.signal,
            ),
          );
        }
        throw new HttpError(403, '模型请求了未授权的产物工具');
      } catch (error) {
        scope.signal.throwIfAborted();
        return JSON.stringify({
          error: error instanceof HttpError ? error.message : '产物生成失败，请核对内容后重试',
        });
      }
    },
  });
}
