/** Generates data/catalog.json: a fictional fan catalogue with performance
 * curves, prices and stock. Deterministic (seeded), so the demo and its
 * recordings stay reproducible. Run `npm run catalog` after changing it. */
import { writeFileSync } from 'node:fs'
import type { CatalogModel } from '../src/types.ts'

let seed = 42
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]

/** Five points of a fan curve: pressure falls with the square of airflow. */
function curve(qMax: number, pMax: number): [number, number][] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => [Math.round(qMax * f), Math.round(pMax * (1 - f * f))])
}

const STOCK = ['in_stock', 'in_stock', 'in_stock', 'in_transit', 'on_order'] as const
const models: CatalogModel[] = []

function add(series: string, category: string, size: string, qMax: number, pMax: number, base: { power: number; noise: number; price: number }) {
  for (const ec of [false, true]) {
    const availability = pick([...STOCK])
    models.push({
      code: `${series}-${size}${ec ? 'E' : ''}`,
      category,
      name: `${category.replace(/s$/, '')} ${size}${ec ? ' EC' : ''}`,
      motor: ec ? 'EC' : 'AC',
      curve: curve(qMax, pMax),
      powerW: Math.round(base.power * (ec ? 0.72 : 1)),
      noiseDbA: Math.round(base.noise - (ec ? 3 : 0)),
      voltage: base.power > 1500 ? '400 V 3~' : '230 V 1~',
      priceUsd: Math.round((base.price * (ec ? 1.45 : 1)) / 5) * 5,
      availability,
      stockQty: availability === 'in_stock' ? 1 + Math.floor(rnd() * 24) : 0,
      etaDays: availability === 'in_transit' ? 5 + Math.floor(rnd() * 8) : availability === 'on_order' ? 30 : 0,
      maxAirTempC: series === 'NW-RF' ? 120 : 60,
    })
  }
}

// Axial wall fans: large airflow, low pressure.
for (const [d, q, p, w, n, price] of [
  [250, 1100, 70, 45, 46, 95], [300, 1900, 90, 70, 49, 120], [350, 2900, 110, 120, 52, 160],
  [400, 4200, 140, 210, 55, 215], [450, 5600, 165, 320, 58, 280], [500, 7200, 190, 450, 61, 360],
] as const) add('NW-AX', 'Axial wall fans', String(d), q, p, { power: w, noise: n, price })

// Circular inline duct fans: modest airflow, medium pressure.
for (const [d, q, p, w, n, price] of [
  [100, 240, 250, 30, 38, 85], [125, 380, 300, 45, 40, 105], [160, 650, 380, 75, 43, 140],
  [200, 1050, 450, 120, 46, 185], [250, 1550, 520, 190, 49, 245], [315, 2300, 600, 300, 52, 330],
] as const) add('NW-ID', 'Inline duct fans', String(d), q, p, { power: w, noise: n, price })

// Rectangular duct fans: large airflow, high pressure.
for (const [s, q, p, w, n, price] of [
  ['40-20', 1500, 420, 230, 50, 410], ['50-25', 2600, 520, 380, 53, 520], ['60-30', 3900, 640, 620, 56, 690],
  ['60-35', 4800, 700, 850, 58, 820], ['70-40', 6500, 780, 1250, 61, 1050], ['80-50', 9000, 860, 2100, 64, 1390],
] as const) add('NW-RD', 'Rectangular duct fans', s, q, p, { power: w, noise: n, price })

// Roof fans: kitchen-rated (120 °C), medium pressure.
for (const [d, q, p, w, n, price] of [
  [250, 1800, 260, 160, 51, 520], [315, 3200, 340, 300, 54, 690], [400, 5200, 430, 550, 57, 920],
  [500, 8100, 520, 1100, 60, 1290], [560, 11000, 600, 1800, 63, 1650],
] as const) add('NW-RF', 'Roof fans', String(d), q, p, { power: w, noise: n, price })

writeFileSync(new URL('../data/catalog.json', import.meta.url), JSON.stringify(models, null, 1))
console.log(`${models.length} models`)
