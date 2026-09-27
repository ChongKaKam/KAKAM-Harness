export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  try {
    if (!document.execCommand('copy')) throw new Error('复制失败，请手动选择文本');
  } finally {
    input.remove();
  }
}
