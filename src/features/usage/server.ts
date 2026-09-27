import { Router } from 'express';
import type { Context } from 'cordis';
import { z } from 'zod';
import { requireUser } from '../../kernel/http';
export { manifest } from './manifest';
export const server = {
  name: 'usage',
  inject: ['db', 'http'],
  apply(ctx: Context) {
    const router = Router();
    router.get('/usage', requireUser, (req, res) => {
      const input = z
        .object({
          days: z.coerce.number().int().min(1).max(730).default(365),
          userId: z.string().uuid().optional(),
        })
        .parse(req.query);
      const userId = req.user!.role === 'admin' ? input.userId : req.user!.id;
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - input.days + 1);
      const since = start.toISOString();
      const where = `WHERE created_at>=? ${userId ? 'AND user_id=?' : ''}`;
      const params = userId ? [since, userId] : [since];
      const totals = ctx.db.get(
        `SELECT coalesce(sum(input_tokens),0) AS input,coalesce(sum(output_tokens),0) AS output,coalesce(sum(total_tokens),0) AS total,count(*) AS requests,coalesce(sum(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END),0) AS unreported FROM usage ${where}`,
        ...params,
      );
      const daily = ctx.db.all(
        `SELECT substr(created_at,1,10) AS day, coalesce(sum(total_tokens),0) AS total FROM usage ${where} GROUP BY day ORDER BY day`,
        ...params,
      );
      const rows = ctx.db.all(
        `SELECT id,(SELECT coalesce(email,username) FROM users WHERE users.id=usage.user_id) AS email,model_name AS modelName,input_tokens AS inputTokens,output_tokens AS outputTokens,total_tokens AS totalTokens,status,created_at AS createdAt FROM usage ${where} ORDER BY created_at DESC LIMIT 200`,
        ...params,
      );
      const activity = ctx.db.all(
        `SELECT substr(created_at,1,10) AS day,model_name AS model,coalesce(sum(total_tokens),0) AS total,count(*) AS requests FROM usage ${where} GROUP BY day,model_name ORDER BY day,model_name`,
        ...params,
      );
      res.json({ totals, daily, rows, activity });
    });
    ctx.effect(() => ctx.http.register(router));
  },
};
