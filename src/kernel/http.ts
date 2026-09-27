import { Service, type Context } from 'cordis';
import type { Request, Response, NextFunction, Router } from 'express';
import type { User } from '../shared/types';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
export const requireUser = (req: Request, _res: Response, next: NextFunction) =>
  req.user ? next() : next(new HttpError(401, '请先登录'));
export const requireAdmin = (req: Request, _res: Response, next: NextFunction) =>
  !req.user
    ? next(new HttpError(401, '请先登录'))
    : req.user.role === 'admin'
      ? next()
      : next(new HttpError(403, '需要管理员权限'));
export class HttpService extends Service {
  private routers: Router[] = [];
  constructor(ctx: Context) {
    super(ctx, 'http', true);
  }
  register(router: Router) {
    this.routers.push(router);
    return () => {
      this.routers = this.routers.filter((r) => r !== router);
    };
  }
  handle = (req: Request, res: Response, next: NextFunction) => {
    const routers = [...this.routers];
    let i = 0;
    const dispatch: NextFunction = (error?: unknown) =>
      error ? next(error) : i < routers.length ? routers[i++](req, res, dispatch) : next();
    dispatch();
  };
}
