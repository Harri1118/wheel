import { build } from 'esbuild'

const PANEL_ENTRIES = ['main', 'explorer', 'inspector', 'node-pane', 'palette', 'settings']

const requestedEntries = process.argv.slice(2)
const entries = requestedEntries.length > 0 ? requestedEntries : PANEL_ENTRIES

await Promise.all(entries.map(bundlePanel))

function bundlePanel(name) {
  if (!PANEL_ENTRIES.includes(name)) {
    throw new Error(`Unknown panel entry "${name}". Expected one of: ${PANEL_ENTRIES.join(', ')}`)
  }

  return build({
    entryPoints: [`src/${name}.ts`],
    outfile: `panel/${name}.js`,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'info',
  })
}
