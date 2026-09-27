import { Router } from 'express';
import type { Context } from 'cordis';
import { z } from 'zod';
import { requireUser } from '../../kernel/http';
import { isRasterImage } from '../../shared/image-validation';
import {
  defaultAccent,
  isAccentColor,
  defaultPattern,
  isColorPattern,
  patternFromAccent,
  type AccentColor,
} from '../../shared/appearance';
export { manifest } from './manifest';
export const server = {
  name: 'preferences',
  inject: ['http', 'db'],
  apply(ctx: Context) {
    const router = Router();
    router.use('/preferences', requireUser);
    router.get('/preferences', (req, res) =>
      res.json(
        ctx.db.get(
          'SELECT theme,assistant_icon AS assistantIcon,accent_color AS accentColor,color_pattern AS colorPattern FROM ui_preferences WHERE user_id=?',
          req.user!.id,
        ) ?? {
          theme: 'system',
          assistantIcon: null,
          accentColor: defaultAccent,
          colorPattern: defaultPattern,
        },
      ),
    );
    router.patch('/preferences', (req, res) => {
      const input = z
        .object({
          theme: z.enum(['light', 'dark', 'system']),
          accentColor: z.custom<AccentColor>(isAccentColor, '请选择有效的主题色').optional(),
          colorPattern: z.custom<string>(isColorPattern, '请选择有效的 Color Pattern').optional(),
          assistantIcon: z
            .string()
            .max(700_000)
            .refine(
              (data) => isRasterImage(data, 512 * 1024),
              '头像需为 512 KB 以内的 PNG、JPEG 或 WebP 图片',
            )
            .nullable(),
        })
        .parse(req.body);
      const accentColor =
        input.accentColor ??
        ctx.db.get<{ accentColor: AccentColor }>(
          'SELECT accent_color AS accentColor FROM ui_preferences WHERE user_id=?',
          req.user!.id,
        )?.accentColor ??
        defaultAccent;
      const colorPattern =
        input.colorPattern ??
        (input.accentColor
          ? patternFromAccent(input.accentColor)
          : (ctx.db.get<{ colorPattern: string }>(
              'SELECT color_pattern AS colorPattern FROM ui_preferences WHERE user_id=?',
              req.user!.id,
            )?.colorPattern ?? defaultPattern));
      ctx.db.run(
        'INSERT INTO ui_preferences(user_id,theme,assistant_icon,accent_color,color_pattern) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,assistant_icon=excluded.assistant_icon,accent_color=excluded.accent_color,color_pattern=excluded.color_pattern',
        req.user!.id,
        input.theme,
        input.assistantIcon,
        accentColor,
        colorPattern,
      );
      res.json({ ...input, accentColor, colorPattern });
    });
    ctx.effect(() => ctx.http.register(router));
  },
};
