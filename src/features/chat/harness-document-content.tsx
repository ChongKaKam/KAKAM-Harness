import { Download } from 'lucide-react';
import { Markdown } from '../../client/markdown';
import { productionBytes } from '../llm-production/presentation';
import type { WorkspaceDocument } from '../harness/types';

export function WorkspaceContent({
  kind,
  content,
}: {
  kind: WorkspaceDocument['kind'];
  content: string;
}) {
  if (kind !== 'artifact') return <Markdown content={content} />;
  try {
    const item = JSON.parse(content);
    if (
      typeof item?.artifactId !== 'string' ||
      !/^[\da-f-]{36}$/i.test(item.artifactId) ||
      typeof item.name !== 'string' ||
      typeof item.size !== 'number'
    ) {
      return <p>文件信息不可用。</p>;
    }
    const url =
      '/api/llm-production/artifacts/' + encodeURIComponent(item.artifactId) + '/download';
    return (
      <>
        <a className="button" href={url} download={item.name}>
          <Download size={16} />
          下载 {item.name} · {productionBytes(item.size)}
        </a>
        {typeof item.text === 'string' && <pre className="harness-file-excerpt">{item.text}</pre>}
      </>
    );
  } catch {
    return <p>文件信息不可用。</p>;
  }
}
