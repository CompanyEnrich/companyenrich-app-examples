import type { Category } from './categorize.ts';

/** Fixed sizes in pixels. The SVG uses them directly; the HTML page uses the same column assignment. */
export const SIZES = {
  width: 1200,
  margin: 32,
  gap: 16,
  headerHeight: 88,
  footerHeight: 64,
  boxPadding: 14,
  boxHeaderHeight: 56,
  tileWidth: 92,
  tileHeight: 86,
  logoSize: 44,
} as const;

export interface PlacedBox {
  category: Category;
  /** Index into the categorical palette, or null for the neutral "Other" box. */
  color: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  tilesPerRow: number;
}

export interface MapLayout {
  width: number;
  height: number;
  boxes: PlacedBox[];
  /** Category indexes per column, top to bottom. */
  columns: number[][];
}

/**
 * Greedy bin packing ("longest processing time first"): take boxes tallest first and drop each into
 * the column that is currently shortest. Simple, and the columns end up within one box of each other.
 * Returns the item indexes in each column, top to bottom.
 */
export function packColumns(heights: number[], columns: number, gap = 0): number[][] {
  const bins = Array.from({ length: columns }, () => ({ height: 0, items: [] as number[] }));
  const tallestFirst = heights.map((_, index) => index).sort((a, b) => heights[b]! - heights[a]! || a - b);
  for (const index of tallestFirst) addToShortest(bins, index, heights[index]! + gap);
  return bins.map((bin) => bin.items);
}

/**
 * Places category boxes. Tries one, two and three columns and keeps whichever gives the shortest map,
 * so a few large categories become wide boxes and many small ones sit side by side.
 */
export function layoutMap(categories: Category[], width: number = SIZES.width): MapLayout {
  const options = [1, 2, 3].filter((columns) => columns === 1 || columns <= categories.length).map((columns) => layoutColumns(categories, columns, width));
  return options.reduce((best, option) => (option.height < best.height ? option : best));
}

/** Packs the boxes into a fixed number of columns. "Other" is packed last so it sits at the bottom of a column. */
export function layoutColumns(categories: Category[], columnTotal: number, width: number = SIZES.width): MapLayout {
  const columnWidth = (width - 2 * SIZES.margin - (columnTotal - 1) * SIZES.gap) / columnTotal;
  const tilesPerRow = Math.max(1, Math.floor((columnWidth - 2 * SIZES.boxPadding) / SIZES.tileWidth));
  const heights = categories.map(
    (category) => SIZES.boxHeaderHeight + Math.ceil(category.companies.length / tilesPerRow) * SIZES.tileHeight + SIZES.boxPadding,
  );

  const main = categories.flatMap((category, index) => (category.kind === 'other' ? [] : [index]));
  const packed = packColumns(
    main.map((index) => heights[index]!),
    columnTotal,
    SIZES.gap,
  ).map((column) => column.map((position) => main[position]!));
  const bins = packed.map((items) => ({ items, height: items.reduce((sum, index) => sum + heights[index]! + SIZES.gap, 0) }));
  categories.forEach((category, index) => {
    if (category.kind === 'other') addToShortest(bins, index, heights[index]! + SIZES.gap);
  });

  let colorSlot = 0;
  const colors = categories.map((category) => (category.kind === 'other' ? null : colorSlot++ % 8));
  const boxes: PlacedBox[] = [];
  bins.forEach((bin, column) => {
    let y = SIZES.headerHeight;
    for (const index of bin.items) {
      boxes.push({
        category: categories[index]!,
        color: colors[index]!,
        x: SIZES.margin + column * (columnWidth + SIZES.gap),
        y,
        width: columnWidth,
        height: heights[index]!,
        tilesPerRow,
      });
      y += heights[index]! + SIZES.gap;
    }
  });

  const tallest = Math.max(0, ...bins.map((bin) => bin.height));
  return {
    width,
    height: SIZES.headerHeight + tallest + SIZES.footerHeight,
    boxes,
    columns: bins.map((bin) => bin.items),
  };
}

function addToShortest(bins: Array<{ height: number; items: number[] }>, index: number, height: number): void {
  const shortest = bins.reduce((best, bin) => (bin.height < best.height ? bin : best));
  shortest.items.push(index);
  shortest.height += height;
}
