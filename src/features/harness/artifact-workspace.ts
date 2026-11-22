import { randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import type { CreateProductionArtifact } from '../llm-production/service';
import { checkTextCapacity } from './workspace';

/** A workspace revision points to the immutable, owner-counted production bytes. The editable
 * workspace APIs reject this kind. All three representations are written in one transaction.
 */
export function recordWorkspaceArtifact(
  ctx: Context,
  userId: string,
  artifactId: string,
  file: CreateProductionArtifact,
) {
  const existing = ctx.db.get<{ id: string; version: number }>(
    `
    SELECT d.id,d.version FROM harness_documents d
    JOIN harness_artifact_revisions r ON r.document_id=d.id JOIN production_artifacts a ON a.id=r.artifact_id
    WHERE d.conversation_id=? AND d.user_id=? AND d.kind='artifact' AND a.name=? COLLATE NOCASE LIMIT 1`,
    file.conversationId,
    userId,
    file.name,
  );
  const documentId = existing?.id ?? randomUUID();
  const version = (existing?.version ?? 0) + 1;
  if (existing)
    ctx.db.run(
      'UPDATE harness_documents SET version=? WHERE id=? AND user_id=?',
      version,
      documentId,
      userId,
    );
  else {
    // A separately authored Markdown document can already use this filename.
    const conflict = ctx.db.get(
      'SELECT 1 FROM harness_documents WHERE conversation_id=? AND user_id=? AND name=?',
      file.conversationId,
      userId,
      file.name,
    );
    const name = conflict ? file.name + ' · ' + artifactId : file.name;
    ctx.db.run(
      "INSERT INTO harness_documents(id,user_id,conversation_id,name,kind,version) VALUES(?,?,?,?,'artifact',?)",
      documentId,
      userId,
      file.conversationId,
      name,
      version,
    );
  }
  const textSource =
    file.workspaceText ??
    (/^text\/|^application\/json$|\+xml$/i.test(file.mimeType)
      ? Buffer.from(file.data.subarray(0, 64000)).toString('utf8')
      : undefined);
  const content = JSON.stringify({
    artifactId,
    name: file.name,
    mimeType: file.mimeType,
    size: file.data.byteLength,
    downloadUrl: `/api/llm-production/artifacts/${artifactId}/download`,
    ...(textSource === undefined
      ? {}
      : {
          text: textSource.slice(0, 32000),
          textSource: file.workspaceText !== undefined ? 'renderer-input' : 'decoded-bytes',
          truncated: textSource.length > 32000 || (!file.workspaceText && file.data.length > 64000),
        }),
  });
  checkTextCapacity(ctx, userId, content);
  ctx.db.run(
    'INSERT INTO harness_revisions(document_id,version,content) VALUES(?,?,?)',
    documentId,
    version,
    content,
  );
  ctx.db.run(
    'INSERT INTO harness_artifact_revisions(document_id,version,artifact_id) VALUES(?,?,?)',
    documentId,
    version,
    artifactId,
  );
}

// Use in queries with a production_artifacts alias named "a". A project can explicitly publish
// a pinned revision even if the source conversation subsequently moves to another project.
export const artifactPublications = `SELECT p.group_id FROM harness_artifact_revisions r
  JOIN harness_publications p ON p.document_id=r.document_id AND p.version=r.version
  WHERE r.artifact_id=a.id AND p.user_id=a.user_id`;
