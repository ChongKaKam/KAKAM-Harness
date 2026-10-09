import type { Context } from 'cordis';
import { z } from 'zod';
import { HttpError } from '../../kernel/http';
import type { ToolDefinition } from '../../adapters/registry';
import type {
  ConversationToolRequirement,
  ConversationToolScope,
} from '../extensions/conversation-tools';
import { renderProduction, productionMimeTypes } from './generators';
import { productionLimits, type ProductionArtifact } from './types';
import { productionRequest } from './request';
import {
  productionFilename,
  productionFormats,
  productionImageMimeTypes,
  productionPlanInput,
} from './delivery';

const fileInput = z
  .object({
    itemId: z.string().uuid().nullable().optional(),
    name: productionFilename,
    format: z.enum(productionFormats),
    content: z.string().min(1).max(productionLimits.textCharacters),
  })
  .strict();
const imageInput = z
  .object({
    itemId: z.string().uuid().nullable().optional(),
    name: productionFilename,
    prompt: z.string().trim().min(1).max(16_000),
  })
  .strict();

function result(artifact: ProductionArtifact) {
  return JSON.stringify({
    id: artifact.id,
    itemId: artifact.deliveryItemId ?? null,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    space: artifact.spaceName,
    expiresAt: artifact.expiresAt,
    downloadUrl: `/api/llm-production/artifacts/${artifact.id}/download`,
  });
}

const itemIdParameter = {
  type: ['string', 'null'],
  description:
    'Server-issued item ID from production_plan. Use null only for an unplanned single artifact in Auto mode.',
};
const planTool: ToolDefinition = {
  name: 'production_plan',
  description:
    'Declare the full delivery list before generating multiple artifacts or a task with dependent steps. Required-artifact mode must declare a plan even for one artifact. Each item means one distinct file; list multiple images separately. Use clarify with an empty items array and a question when a necessary requirement is ambiguous. Plans are locked for this reply and cannot be shortened or changed. The server returns stable item IDs. No scripts or sandbox execution are available.',
  parameters: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['deliver', 'clarify'] },
      items: {
        type: 'array',
        maxItems: productionLimits.deliveryItems,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['file', 'image'] },
            format: {
              type: ['string', 'null'],
              enum: [...productionFormats, null],
              description:
                'An explicit supported format for a file, or null if unspecified. Native image generation always uses null.',
            },
            name: { type: 'string' },
            brief: {
              type: 'string',
              description: 'The content or visual requirements of this one artifact.',
            },
          },
          required: ['kind', 'format', 'name', 'brief'],
          additionalProperties: false,
        },
      },
      question: {
        type: ['string', 'null'],
        description: 'Required clarification question for clarify, otherwise null.',
      },
    },
    required: ['decision', 'items', 'question'],
    additionalProperties: false,
  },
};
const fileTool: ToolDefinition = {
  name: 'production_create_file',
  description:
    'Create a real downloadable file. text/markdown/json/csv/html/svg take UTF-8 contents; PDF and DOCX take plain text with paragraphs. XLSX content is JSON {"sheets":[{"name":"Sheet1","rows":[["Name","Value"],["Example",12]]}]}; cells must be strings, numbers, booleans or null. PPTX content is JSON {"slides":[{"title":"Title","body":["Point one","Point two"]}]}. Files are stored only after successful rendering. HTML/SVG are download-only, never executed in chat. After a delivery plan, supply its itemId and match its kind and explicit format.',
  parameters: {
    type: 'object',
    properties: {
      itemId: itemIdParameter,
      name: {
        type: 'string',
        description: 'User-facing filename, including the appropriate extension.',
      },
      format: { type: 'string', enum: [...productionFormats] },
      content: {
        type: 'string',
        description: 'File contents or serialized document JSON. Maximum 500000 characters.',
      },
    },
    required: ['itemId', 'name', 'format', 'content'],
    additionalProperties: false,
  },
};
const imageTool: ToolDefinition = {
  name: 'production_generate_image',
  description:
    'Generate one native image with the user-selected authorized image model and save it to the private artifact space. Supply the server-issued plan itemId, or null for a simple unplanned Auto request. The result contains real download metadata. A completed item returns the saved artifact without another paid generation. Do not retry a failed image within the same reply.',
  parameters: {
    type: 'object',
    properties: {
      itemId: itemIdParameter,
      name: { type: 'string' },
      prompt: { type: 'string' },
    },
    required: ['itemId', 'name', 'prompt'],
    additionalProperties: false,
  },
};

export function registerProductionTools(ctx: Context) {
  function authorizeImage(user: ConversationToolScope['user']) {
    const modelId = ctx.production.preferences(user.id).imageModelId;
    if (!modelId) throw new HttpError(400, '请先在设置 → 产物空间选择图片模型');
    try {
      ctx.models.authorize(user, modelId, 'image');
    } catch {
      throw new HttpError(400, '所选图片模型已停用或未授权，请在产物设置中重新选择');
    }
    return modelId;
  }

  return ctx.extensions.registerConversationTools({
    id: 'llm-production',
    instructions:
      "Production tools create real downloadable artifacts. Interpret the user's requested deliverables using the conversation context. When an artifact output is requested, use the corresponding production tool; a description or code block alone does not deliver an artifact. A simple single artifact in Auto mode may be generated directly with itemId=null. For multiple files, multiple images, mixed deliverables or dependent steps, call production_plan first with the full list, one item per actual file, and then generate every item with its server-issued itemId. In required-artifact mode always call production_plan before generation. Plan formats and contents follow the user's needs; never hardcode a format based on an example task. Honor explicit formats and filenames. Use production_create_file for documents, data, code, webpages and explicitly requested SVG files, and production_generate_image for native images. Native images cannot be replaced by a prompt, Markdown image link or SVG. Code examples, explanations and quoted requests alone do not request artifacts. If a requirement cannot be fulfilled without clarification, call production_plan with clarify and ask the returned question. Unsupported capabilities must be explained; do not silently substitute another format. Only claim creation from successful tool results and use their real download URLs. Do not repeat a failed image generation request within the same reply. Files use this conversation's private space, shared with its group when grouped. Fixed document renderers do not execute scripts. Existing shared files remain in their original group when their source conversation moves or is deleted.",
    requirement(user, content, requireDelivery = false) {
      const request = productionRequest(content);
      if (!request && !requireDelivery) return;
      if (!ctx.production.preferences(user.id).enabled)
        throw new HttpError(400, '请先在产物设置中启用生成');
      if (request?.kind === 'image') authorizeImage(user);
      const label =
        request?.kind === 'image'
          ? '图片'
          : request?.format
            ? `${request.format.toUpperCase()} 文件`
            : '文件';
      const satisfiesOriginalRequest = (scope: ConversationToolScope) =>
        !request ||
        ctx.production
          .forMessage(scope.user.id, scope.messageId)
          .some((artifact) =>
            request.kind === 'image'
              ? productionImageMimeTypes.includes(artifact.mimeType)
              : request.format
                ? artifact.mimeType === productionMimeTypes[request.format]
                : !productionImageMimeTypes.includes(artifact.mimeType),
          );
      if (requireDelivery)
        return {
          toolName: 'production_plan',
          maxRounds: productionLimits.deliveryItems + 2,
          instructions: `Required artifact mode: call production_plan before generating anything. Declare the full delivery list, or clarify the missing requirement with a question. ${request ? `The original request requires ${label}${request.format ? ` with format=${request.format}` : ''}; the plan and actual output must honor it. ` : ''}This reply cannot finish with only an explanation or code block.`,
          failureMessage: request
            ? `模型未声明产物交付计划，或未交付所请求的${label}；请检查交付内容后重试`
            : '模型没有声明产物交付计划；请检查聊天模型的工具调用能力后重试',
          satisfied(scope) {
            const plan = ctx.production.delivery(scope.user.id, scope.messageId);
            return (
              plan?.decision === 'clarify' || (plan !== null && satisfiesOriginalRequest(scope))
            );
          },
        };
      const toolName =
        request!.kind === 'image' ? 'production_generate_image' : 'production_create_file';
      return {
        toolName,
        stopOnFailure: request!.kind === 'image',
        instructions: `Required artifact: ${label}. Deliver the requested real artifact before the final answer. Use a plan for multiple outputs or dependent steps, or clarify missing requirements. A description or code block does not fulfill the request. Do not repeat failed image generation automatically.`,
        failureMessage: `模型未生成所请求的${label}；未成功调用产物工具或文件未保存，请检查模型的工具调用能力后重试`,
        satisfied(scope) {
          const delivery = ctx.production.delivery(scope.user.id, scope.messageId);
          if (delivery?.decision === 'clarify') return true;
          return satisfiesOriginalRequest(scope);
        },
      };
    },
    requirements(scope) {
      const plan = ctx.production.delivery(scope.user.id, scope.messageId);
      const requirements: ConversationToolRequirement[] = [];
      if (plan?.decision === 'deliver')
        for (const item of plan.items) {
          if (item.status === 'complete') continue;
          requirements.push({
            toolName:
              item.kind === 'image' ? 'production_generate_image' : 'production_create_file',
            maxRounds: productionLimits.deliveryItems + 2,
            stopOnFailure: item.kind === 'image' && item.status === 'failed',
            instructions:
              item.status === 'failed'
                ? `Delivery item ${item.id} failed. Do not retry image generation within this reply.`
                : `Required delivery item ${item.id}: ${item.name}. Generate this one ${item.kind}${item.format ? ` with format=${item.format}` : ''} using its itemId. Requirement: ${item.brief}`,
            failureMessage:
              item.error ?? `未完成产物交付：${item.name}；需要独立且符合计划的实际文件`,
            satisfied(current) {
              return (
                ctx.production
                  .delivery(current.user.id, current.messageId)
                  ?.items.some((entry) => entry.id === item.id && entry.status === 'complete') ??
                false
              );
            },
          });
        }
      const imageFailure = ctx.production.imageFailure(scope.user.id, scope.messageId);
      if (imageFailure)
        requirements.push({
          toolName: 'production_generate_image',
          stopOnFailure: true,
          instructions:
            'The native image request failed. Do not repeat the paid image call within this reply.',
          failureMessage: imageFailure,
          satisfied() {
            return false;
          },
        });
      return requirements;
    },
    tools(user, scope) {
      const preferences = ctx.production.preferences(user.id);
      if (!preferences.enabled) return [];
      const plan = scope ? ctx.production.delivery(user.id, scope.messageId) : null;
      if (scope?.requireDelivery && !plan) return [planTool];
      if (plan?.decision === 'clarify') return [planTool];
      const tools: ToolDefinition[] = [planTool];
      if (!plan || plan.items.some((item) => item.kind === 'file')) tools.push(fileTool);
      if (!scope || !ctx.production.imageFailure(user.id, scope.messageId)) {
        if (!plan || plan.items.some((item) => item.kind === 'image' && item.status !== 'failed')) {
          try {
            authorizeImage(user);
            tools.push(imageTool);
          } catch {
            /* Current grants are checked again at plan declaration and execution. */
          }
        }
      }
      return tools;
    },
    async execute(scope, call) {
      const key = `${scope.messageId}:${scope.requestId}:${call.id}`;
      let attemptedImage = false;
      let imageItemId: string | null | undefined;
      try {
        const scopeInput = {
          conversationId: scope.conversationId,
          messageId: scope.messageId,
          idempotencyKey: key,
        };
        if (call.name === 'production_plan') {
          const parsed = productionPlanInput.safeParse(call.arguments);
          if (!parsed.success)
            throw new HttpError(400, '交付计划参数无效，请按每个文件一项声明产物，或提出澄清问题');
          if (parsed.data.items.some((item) => item.kind === 'image')) authorizeImage(scope.user);
          scope.signal.throwIfAborted();
          return JSON.stringify(ctx.production.declareDelivery(scope, parsed.data));
        }
        if (call.name === 'production_create_file') {
          const parsed = fileInput.safeParse(call.arguments);
          if (!parsed.success)
            throw new HttpError(400, '文件参数无效，请核对交付项目、文件名、格式与内容');
          const delivery = ctx.production.deliveryItem(
            scope,
            parsed.data.itemId,
            'file',
            parsed.data.format,
          );
          if (delivery.artifact) return result(delivery.artifact);
          const file = await renderProduction(parsed.data);
          scope.signal.throwIfAborted();
          return result(
            ctx.production.create(
              scope.user,
              { ...scopeInput, ...file, deliveryItemId: parsed.data.itemId },
              scope.signal,
            ),
          );
        }
        if (call.name === 'production_generate_image') {
          const parsed = imageInput.safeParse(call.arguments);
          if (!parsed.success)
            throw new HttpError(400, '图片参数无效，请提供交付项目、文件名和描述');
          imageItemId = parsed.data.itemId;
          const delivery = ctx.production.deliveryItem(scope, imageItemId, 'image');
          if (delivery.artifact) return result(delivery.artifact);
          const existing = ctx.production.findCreated(scope.user.id, key);
          if (existing) {
            if ((existing.deliveryItemId ?? null) !== (imageItemId ?? null))
              throw new HttpError(409, '产物请求标识已被其他交付项目使用');
            return result(existing);
          }
          const modelId = authorizeImage(scope.user);
          const storage = ctx.production.storage(scope.user.id);
          if (storage.usedBytes >= storage.limitBytes)
            throw new HttpError(400, '产物空间已满，请删除部分文件后重试');
          attemptedImage = true;
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
              {
                ...scopeInput,
                name,
                mimeType: image.mimeType,
                data: image.data,
                deliveryItemId: imageItemId,
              },
              scope.signal,
            ),
          );
        }
        throw new HttpError(403, '模型请求了未授权的产物工具');
      } catch (error) {
        const message =
          error instanceof HttpError ? error.message : '产物生成失败，请核对内容后重试';
        if (attemptedImage) {
          try {
            ctx.production.markImageFailed(scope, imageItemId, message);
          } catch (recordError) {
            // Deleting the source conversation may remove the message while the image call stops.
            if (!(recordError instanceof HttpError && recordError.status === 404))
              throw recordError;
          }
        }
        scope.signal.throwIfAborted();
        return JSON.stringify({ error: message });
      }
    },
  });
}
