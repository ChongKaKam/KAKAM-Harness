import type { ContextSection, ContextSectionId } from './types';

const gridSize = 32 * 7;

export function characterGrid(sections: Pick<ContextSection, 'id' | 'characters'>[]) {
  let charactersPerCell = 64;
  const filledCells = () =>
    sections.reduce((sum, section) => sum + Math.ceil(section.characters / charactersPerCell), 0);
  while (filledCells() > gridSize) charactersPerCell *= 2;

  const cells: (ContextSectionId | null)[] = [];
  for (const section of sections) {
    for (let index = 0; index < Math.ceil(section.characters / charactersPerCell); index++) {
      cells.push(section.id);
    }
  }
  while (cells.length < gridSize) cells.push(null);
  return { cells, charactersPerCell };
}
