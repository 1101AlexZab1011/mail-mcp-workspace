import { reactive } from 'vue'

export interface FontOption {
  label: string
  value: string
}

// Fonts bundled with the app (src/assets/fonts); the host page adds the system's fonts (addFonts).
export const FONTS: FontOption[] = reactive([
  { label: 'Default font', value: '' },
  { label: 'Source Serif 4', value: 'SourceSerif4' },
  { label: 'JetBrains Mono', value: 'JetBrainsMono' },
  { label: 'Literata', value: 'Literata' },
  { label: 'Inter', value: 'Inter' },
  { label: 'Roboto', value: 'Roboto' },
  { label: 'Open Sans', value: 'OpenSans' },
  { label: 'Montserrat', value: 'Montserrat' },
  { label: 'Source Sans Pro', value: 'SourceSansPro' },
  { label: 'Merriweather', value: 'Merriweather' },
  { label: 'Lato', value: 'Lato' },
])

/** Add font families (e.g. the system's), skipping ones already listed; keeps the list sorted after the default. */
export const addFonts = (families: string[]) => {
  const known = new Set(FONTS.flatMap(font => [font.label.toLowerCase(), font.value.toLowerCase()]))
  const added = families.filter(family => family && !known.has(family.toLowerCase())).map(family => ({ label: family, value: family }))
  if (!added.length) return
  const rest = [...FONTS.slice(1), ...added].sort((a, b) => a.label.localeCompare(b.label))
  FONTS.splice(1, FONTS.length - 1, ...rest)
}
