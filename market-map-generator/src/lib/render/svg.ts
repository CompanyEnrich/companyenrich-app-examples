import type { Company } from '@companyenrich/sdk';
import { layoutMap, SIZES, type MapLayout, type PlacedBox } from '../layout.ts';
import { initials } from '../logos.ts';
import { accentVar, colorTokens, escapeXml as esc, methodLine, sourceLine, subtitle, truncate, type MarketMap } from './markup.ts';

/**
 * Average character width as a share of the font size, used to shorten text that SVG cannot wrap.
 * It is an estimate (wide letters like "W" are wider), so every label is also clipped to its area.
 */
const CHAR_WIDTH = 0.6;

const STYLE = `${colorTokens('svg')}
text { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: var(--ink); }
.page { fill: var(--page); }
.title { font-size: 26px; font-weight: 700; }
.subtitle { font-size: 13px; fill: var(--ink-2); }
.box { fill: var(--surface); stroke: var(--border); }
.box-title { font-size: 15px; font-weight: 650; }
.box-count { font-size: 12px; fill: var(--muted); }
.box-desc { font-size: 12px; fill: var(--ink-2); }
.logo-bg { fill: var(--tile); stroke: var(--border); }
image { color-scheme: light; }
.initials-bg { fill: var(--initials-bg); }
.initials { font-size: 15px; font-weight: 650; fill: var(--ink-2); }
.tile-name { font-size: 11px; }
.footer { font-size: 11px; fill: var(--muted); }`;

/** Renders the map as one standalone SVG file: logos are embedded, colors follow the viewer's light or dark mode. */
export function renderSvg(map: MarketMap, layout: MapLayout = layoutMap(map.categories)): string {
  const { width, height } = layout;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="map-title map-desc">`,
    `<title id="map-title">${esc(map.title)}: market map</title>`,
    `<desc id="map-desc">${esc(`${subtitle(map)}. ${sourceLine(map)}.`)}</desc>`,
    `<style>\n${STYLE}\n</style>`,
    '<defs>',
    '<clipPath id="logo-clip" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="0.2" ry="0.2"/></clipPath>',
    `<clipPath id="tile-clip"><rect x="2" width="${SIZES.tileWidth - 4}" height="${SIZES.tileHeight}"/></clipPath>`,
    `<clipPath id="page-text"><rect x="${SIZES.margin}" width="${width - 2 * SIZES.margin}" height="${height}"/></clipPath>`,
    '</defs>',
    `<rect class="page" width="${width}" height="${height}"/>`,
    `<g clip-path="url(#page-text)">`,
    `<text class="title" x="${SIZES.margin}" y="46">${esc(truncate(map.title, 70))}</text>`,
    `<text class="subtitle" x="${SIZES.margin}" y="70">${esc(subtitle(map))}</text>`,
    '</g>',
    ...layout.boxes.map((box, index) => renderBox(map, box, index)),
    `<g clip-path="url(#page-text)">`,
    `<text class="footer" x="${SIZES.margin}" y="${height - 38}">${esc(truncate(sourceLine(map), 190))}</text>`,
    `<text class="footer" x="${SIZES.margin}" y="${height - 20}">${esc(truncate(methodLine(map), 190))}</text>`,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

function renderBox(map: MarketMap, box: PlacedBox, index: number): string {
  const { width, height, category, tilesPerRow } = box;
  const pad = SIZES.boxPadding;
  const id = `box-${index}`;
  const countWidth = 36;
  const gridOffset = (width - 2 * pad - tilesPerRow * SIZES.tileWidth) / 2;
  const tiles = category.companies.map((company, position) => {
    const x = pad + gridOffset + (position % tilesPerRow) * SIZES.tileWidth;
    const y = SIZES.boxHeaderHeight + Math.floor(position / tilesPerRow) * SIZES.tileHeight;
    return renderTile(map, company, x, y);
  });
  const titleChars = Math.floor((width - 2 * pad - countWidth) / (15 * CHAR_WIDTH));
  const descriptionChars = Math.floor((width - 2 * pad) / (12 * CHAR_WIDTH));

  return [
    `<g transform="translate(${round(box.x)} ${round(box.y)})">`,
    `<clipPath id="${id}"><rect width="${round(width)}" height="${height}" rx="10"/></clipPath>`,
    `<clipPath id="${id}-title"><rect x="${pad}" width="${round(width - 2 * pad - countWidth)}" height="40"/></clipPath>`,
    `<clipPath id="${id}-text"><rect x="${pad}" width="${round(width - 2 * pad)}" height="${SIZES.boxHeaderHeight}"/></clipPath>`,
    `<rect class="box" x="0.5" y="0.5" width="${round(width - 1)}" height="${height - 1}" rx="10"/>`,
    `<rect width="${round(width)}" height="5" clip-path="url(#${id})" style="fill: ${accentVar(box.color)}"/>`,
    `<text class="box-title" x="${pad}" y="30" clip-path="url(#${id}-title)">${esc(truncate(category.name, titleChars))}</text>`,
    `<text class="box-count" x="${round(width - pad)}" y="30" text-anchor="end">${category.companies.length}</text>`,
    `<text class="box-desc" x="${pad}" y="48" clip-path="url(#${id}-text)">${esc(truncate(category.description, descriptionChars))}</text>`,
    ...tiles,
    '</g>',
  ].join('\n');
}

/** One logo and name, drawn in tile-local coordinates so the shared tile clip keeps long names inside the tile. */
function renderTile(map: MarketMap, company: Company, x: number, y: number): string {
  const name = company.name ?? company.domain;
  const center = SIZES.tileWidth / 2;
  const logoX = round(center - SIZES.logoSize / 2);
  const logoY = 4;
  const logo = map.logos.get(company.id);
  const mark = logo
    ? `<rect class="logo-bg" x="${logoX}" y="${logoY}" width="${SIZES.logoSize}" height="${SIZES.logoSize}" rx="9"/>` +
      `<image href="${esc(logo)}" x="${logoX}" y="${logoY}" width="${SIZES.logoSize}" height="${SIZES.logoSize}" clip-path="url(#logo-clip)" preserveAspectRatio="xMidYMid meet"/>`
    : `<rect class="initials-bg" x="${logoX}" y="${logoY}" width="${SIZES.logoSize}" height="${SIZES.logoSize}" rx="9"/>` +
      `<text class="initials" x="${center}" y="${logoY + 28}" text-anchor="middle">${esc(initials(name))}</text>`;
  const tooltip = truncate(`${name} (${company.domain})${company.description ? `: ${company.description}` : ''}`, 300);
  const nameChars = Math.floor((SIZES.tileWidth - 6) / (11 * CHAR_WIDTH));

  return [
    `<a href="${esc(`https://${company.domain}`)}" target="_blank">`,
    `<title>${esc(tooltip)}</title>`,
    `<g transform="translate(${round(x)} ${y})"><g clip-path="url(#tile-clip)">`,
    mark,
    `<text class="tile-name" x="${center}" y="${logoY + SIZES.logoSize + 18}" text-anchor="middle">${esc(truncate(name, nameChars))}</text>`,
    '</g></g>',
    '</a>',
  ].join('');
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
