/**
 * Reference data for US plans. CompanyEnrich's `geo.searchStates` returns US states with their
 * USPS codes ("CA", "NY"), which is what both tables below are keyed by.
 */

/** The nine US Census Bureau divisions, used by --keep-regions. Puerto Rico and other areas have none. */
export const US_CENSUS_DIVISIONS: Record<string, readonly string[]> = {
  'New England': ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'],
  'Middle Atlantic': ['NJ', 'NY', 'PA'],
  'East North Central': ['IL', 'IN', 'MI', 'OH', 'WI'],
  'West North Central': ['IA', 'KS', 'MN', 'MO', 'NE', 'ND', 'SD'],
  'South Atlantic': ['DE', 'DC', 'FL', 'GA', 'MD', 'NC', 'SC', 'VA', 'WV'],
  'East South Central': ['AL', 'KY', 'MS', 'TN'],
  'West South Central': ['AR', 'LA', 'OK', 'TX'],
  Mountain: ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY'],
  Pacific: ['AK', 'CA', 'HI', 'OR', 'WA'],
};

const DIVISION_BY_STATE = new Map(
  Object.entries(US_CENSUS_DIVISIONS).flatMap(([division, codes]) => codes.map((code) => [code, division] as const)),
);

export function usCensusDivision(stateCode: string | undefined): string | null {
  return (stateCode && DIVISION_BY_STATE.get(stateCode)) || null;
}

export interface TilePosition {
  row: number;
  col: number;
}

/**
 * A widely used square tile-grid layout of the US: one equal-sized tile per state, placed to keep
 * neighbours roughly next to each other, with Alaska and Hawaii in the left corners and Puerto
 * Rico added at the bottom right. 8 rows by 11 columns, zero-based.
 */
export const US_TILE_GRID_ROWS: readonly (readonly (string | null)[])[] = [
  ['AK', null, null, null, null, null, null, null, null, null, 'ME'],
  [null, null, null, null, null, null, null, null, null, 'VT', 'NH'],
  ['WA', 'ID', 'MT', 'ND', 'MN', 'IL', 'WI', 'MI', 'NY', 'RI', 'MA'],
  ['OR', 'NV', 'WY', 'SD', 'IA', 'IN', 'OH', 'PA', 'NJ', 'CT', null],
  ['CA', 'UT', 'CO', 'NE', 'MO', 'KY', 'WV', 'VA', 'MD', 'DE', null],
  [null, 'AZ', 'NM', 'KS', 'AR', 'TN', 'NC', 'SC', 'DC', null, null],
  [null, null, null, 'OK', 'LA', 'MS', 'AL', 'GA', null, null, null],
  ['HI', null, null, 'TX', null, null, null, null, 'FL', null, 'PR'],
];

export const US_TILE_GRID_COLUMNS = 11;

export const US_TILE_POSITIONS: ReadonlyMap<string, TilePosition> = new Map(
  US_TILE_GRID_ROWS.flatMap((cells, row) =>
    cells.flatMap((code, col) => (code ? [[code, { row, col }] as const] : [])),
  ),
);
