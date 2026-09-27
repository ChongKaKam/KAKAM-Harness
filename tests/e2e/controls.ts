import { expect, type Page } from '@playwright/test';

export async function chooseModel(page: Page, value: { id: string } | { label: string }) {
  await page.getByRole('button', { name: /^模型与思考程度：/ }).click();
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  const list = page.getByRole('radiogroup', { name: '可用模型' });
  const option =
    'id' in value
      ? list.locator(`[data-model-id="${value.id}"]`)
      : list.getByRole('radio', { name: value.label, exact: true });
  await option.click();
  await page.getByRole('button', { name: '关闭模型设置' }).click();
  await expect(page.getByRole('dialog', { name: '模型与思考设置' })).toHaveCount(0);
}
export async function chooseEffort(page: Page, name: string) {
  await page.getByRole('button', { name: /^模型与思考程度：/ }).click();
  await page.getByRole('button', { name: `思考程度 ${name}`, exact: true }).click();
  await page.getByRole('button', { name: '关闭模型设置' }).click();
}
