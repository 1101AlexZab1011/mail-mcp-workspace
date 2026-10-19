// TeX → one filled SVG path, via MathJax. The latex element stores a single path and its box, so the
// glyphs are flattened: every <path> and <rect> MathJax draws is mapped through its transforms into
// the formula's own coordinates, then scaled to pixels.
import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import { SVGPathData } from 'svg-pathdata'

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)
const packages = AllPackages.filter(name => name !== 'require' && name !== 'autoload')
const document = mathjax.document('', {
  InputJax: new TeX({ packages, formatError: (_jax: unknown, error: Error) => { throw error } }),
  OutputJax: new SVG({ fontCache: 'none' }),
})

/** Pixels per em of the rendered formula (MathJax draws 1000 units per em). */
const FONT_SIZE = 40

/** The SVG markup MathJax produces (for previews). */
export const latexToSVG = (latex: string, display = true) => {
  const node = document.convert(latex, { display })
  return adaptor.innerHTML(node)
}

export interface LatexPath {
  path: string
  w: number
  h: number
}

/** Render TeX to a single path in pixel coordinates; throws on TeX errors. */
export const renderLatex = (latex: string): LatexPath => {
  const markup = latexToSVG(latex)
  const host = window.document.createElement('div')
  host.style.cssText = 'position: fixed; left: -20000px; top: 0; visibility: hidden;'
  host.innerHTML = markup
  window.document.body.append(host)
  try {
    const svg = host.querySelector('svg') as SVGSVGElement
    const [minX, minY, width, height] = (svg.getAttribute('viewBox') ?? '0 0 0 0').split(/\s+/).map(Number)
    // Map each shape into the root's user space (viewBox units); the viewBox then gives the extent.
    svg.setAttribute('width', `${width}`)
    svg.setAttribute('height', `${height}`)
    const rootInverse = svg.getScreenCTM()!.inverse()
    const scale = FONT_SIZE / 1000
    const parts: string[] = []
    for (const shape of svg.querySelectorAll('path, rect')) {
      const element = shape as SVGGraphicsElement
      const ctm = element.getScreenCTM()
      if (!ctm) continue
      const m = rootInverse.multiply(ctm)
      let d: string
      if (element.tagName === 'rect') {
        const x = Number(element.getAttribute('x') ?? 0)
        const y = Number(element.getAttribute('y') ?? 0)
        const w = Number(element.getAttribute('width') ?? 0)
        const h = Number(element.getAttribute('height') ?? 0)
        d = `M${x} ${y}H${x + w}V${y + h}H${x}Z`
      }
      else d = element.getAttribute('d') ?? ''
      if (!d) continue
      const mapped = new SVGPathData(d).toAbs()
        .matrix(m.a, m.b, m.c, m.d, m.e, m.f)
        .translate(-minX, -minY)
        .scale(scale, scale)
        .round(100)
      parts.push(mapped.encode())
    }
    return { path: parts.join(''), w: Math.ceil(width * scale), h: Math.ceil(height * scale) }
  }
  finally {
    host.remove()
  }
}
