import type { Context } from 'cordis';
import type { Router } from 'express';
import { z } from 'zod';
import { HttpError, requireUser } from '../../kernel/http';
import type { User } from '../../shared/types';
import type { WorkspaceApproval } from './types';
import {
  createWorkspaceDocument,
  updateWorkspaceDocument,
  readWorkspaceDocument,
  workspaceVersions,
  publishWorkspaceDocument,
  shareWorkspaceDocument,
  requestWorkspaceAccess,
  decideWorkspaceAccess,
  preauthorizeWorkspaceAccess,
  createWorkspacePreference,
  editWorkspacePreference,
  decideWorkspacePreference,
  workspaceView,
  isHarnessConversation,
  readWorkspaceApproval,
  listWorkspaceApprovals,
} from './workspace';

export function registerWorkspaceRoutes(
  ctx: Context,
  router: Router,
  onApproved?: (user: User, grant: WorkspaceApproval) => void,
) {
  const base = '/conversations/:id/workspace';
  const id = z.string().uuid();
  function receipt(user: User, result: WorkspaceApproval, shouldResume: boolean) {
    if (shouldResume) {
      try {
        onApproved?.(user, result);
      } catch (error) {
        return {
          ...result,
          resumeError: error instanceof HttpError ? error.message : '自动继续失败，可手动继续',
        };
      }
    }
    return result;
  }
  router.use(base, requireUser, (req, _res, next) => {
    if (!isHarnessConversation(ctx, req.user!.id, id.parse(req.params.id)))
      throw new HttpError(404, '工作区不存在');
    next();
  });
  router.get(base, (req, res) => res.json(workspaceView(ctx, req.user!.id, String(req.params.id))));
  router.post(base + '/documents', (req, res) =>
    res
      .status(201)
      .json(createWorkspaceDocument(ctx, req.user!.id, String(req.params.id), req.body)),
  );
  router.get(base + '/documents/:docId', (req, res) =>
    res.json(
      readWorkspaceDocument(
        ctx,
        req.user!.id,
        String(req.params.id),
        id.parse(req.params.docId),
        z.coerce.number().int().positive().optional().parse(req.query.version),
      ),
    ),
  );
  router.get(base + '/documents/:docId/versions', (req, res) =>
    res.json(
      workspaceVersions(ctx, req.user!.id, String(req.params.id), id.parse(req.params.docId)),
    ),
  );
  router.patch(base + '/documents/:docId', (req, res) =>
    res.json(
      updateWorkspaceDocument(
        ctx,
        req.user!.id,
        String(req.params.id),
        id.parse(req.params.docId),
        req.body,
        true,
      ),
    ),
  );
  router.post(base + '/shares', (req, res) =>
    res.json(shareWorkspaceDocument(ctx, req.user!.id, String(req.params.id), req.body)),
  );
  router.post(base + '/publish', (req, res) =>
    res.json(publishWorkspaceDocument(ctx, req.user!.id, String(req.params.id), req.body)),
  );
  router.get(base + '/requests', (req, res) =>
    res.json(listWorkspaceApprovals(ctx, req.user!.id, String(req.params.id))),
  );
  router.post(base + '/requests', (req, res) =>
    res.json(requestWorkspaceAccess(ctx, req.user!.id, String(req.params.id), req.body)),
  );
  router.post(base + '/requests/:requestId/decision', (req, res) => {
    const requestId = id.parse(req.params.requestId);
    const previous = readWorkspaceApproval(ctx, req.user!.id, String(req.params.id), requestId);
    const result = decideWorkspaceAccess(
      ctx,
      req.user!.id,
      String(req.params.id),
      requestId,
      req.body,
    );
    res.json(
      receipt(req.user!, result, previous.status === 'pending' && result.status === 'approved'),
    );
  });
  router.post(base + '/grants', (req, res) => {
    let matchedPending = false;
    const result = preauthorizeWorkspaceAccess(
      ctx,
      req.user!.id,
      String(req.params.id),
      req.body,
      () => {
        matchedPending = true;
      },
    );
    res.json(receipt(req.user!, result, matchedPending));
  });
  router.post(base + '/preferences', (req, res) =>
    res.status(201).json(createWorkspacePreference(ctx, req.user!.id, req.body)),
  );
  router.patch(base + '/preferences/:prefId', (req, res) =>
    res.json(editWorkspacePreference(ctx, req.user!.id, id.parse(req.params.prefId), req.body)),
  );
  router.post(base + '/preferences/:prefId/decision', (req, res) =>
    res.json(decideWorkspacePreference(ctx, req.user!.id, id.parse(req.params.prefId), req.body)),
  );
}
