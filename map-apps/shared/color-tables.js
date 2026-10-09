import tables from '../../test_data/color_tables.json' with { type: 'json' };
export const COLOR_TABLES = tables;
export const COLOR_TABLE_STYLE = 'benchmark';

export function colorTableStyle(layer) {
  const variable = tables.aliases[layer.variable] ?? layer.variable;
  const table = tables.tables[variable] ?? tables.fallback;
  if (!layer.style) throw new Error('Raster layer is missing its value/color scale.');
  return { ...layer.style, colors: table.colors.map((rgb) => [...rgb]),
    colorTable: tables.id + '/' + table.name };
}

export function restyledLayer(layer) {
  return { ...layer, style: colorTableStyle(layer), colorTableStyle: COLOR_TABLE_STYLE };
}
