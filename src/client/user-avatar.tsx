import { useState } from 'react';
import type { User } from '../shared/types';

export function UserAvatar({
  user,
  size = '',
}: {
  user: Pick<User, 'displayName' | 'avatar'>;
  size?: 'large' | 'tiny' | '';
}) {
  const [failed, setFailed] = useState<string>();
  return (
    <span className={`avatar user-avatar ${size}`}>
      {user.avatar && failed !== user.avatar ? (
        <img
          src={user.avatar}
          alt={`${user.displayName}的头像`}
          onError={() => setFailed(user.avatar!)}
        />
      ) : (
        user.displayName.slice(0, 1)
      )}
    </span>
  );
}

/** Normalize a local photograph to a small raster; never store the original upload. */
export async function prepareAvatar(file: File): Promise<string> {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error('无法读取图片');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(side, 512);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法处理图片');
    ctx.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    let result = canvas.toDataURL('image/webp', 0.85);
    if (result.length > 690_000) result = canvas.toDataURL('image/jpeg', 0.8);
    if (result.length > 690_000) throw new Error('图片处理后仍过大，请选择较小图片');
    return result;
  } catch (error) {
    if (error instanceof Error && !(error instanceof DOMException)) throw error;
    throw new Error('图片无法解码，请选择有效的 PNG、JPEG 或 WebP 图片');
  } finally {
    URL.revokeObjectURL(url);
  }
}
