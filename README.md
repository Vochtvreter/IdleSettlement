# Hearthlands — an idle settlement saga

Lead seven wanderers from a single campfire to a civilisation that raises **the Sunspire**, a wonder for the ages.
Hearthlands is a semi-idle game: time flows on its own, people are born, grow up, work, age and die, and your job is
to guide them — assign work, place buildings on a living pixel-art map, explore the wilds and push through five ages.

A full playthrough takes roughly **35–60 minutes at normal speed** (2× and 5× speeds are available), and there is a
New Game+ "Legacy" loop afterwards.

## Features

- **Living population** — every settler has a name, age, generation and job. Births need free housing, food and good
  morale; people die of old age, illness, hunger, cold, wolves or raids. Children come of age at 13, elders retire at 52.
- **Seasons** — four seasons per year. Winter brings poor foraging, no harvest and a need for firewood, so you stockpile.
- **Interactive map** — procedurally generated terrain (rivers, coasts, forests, hills, mountains) with fog of war.
  Place buildings inside your territory; adjacency matters (lumber camps by forests, farms by water, mines on ore veins).
- **Exploration** — scouts push back the fog. Click any dark area to send them there. Find ruins, supply caches,
  wanderer camps that join you, sacred groves, game herds and ore veins.
- **Five ages, 24 discoveries, 16 buildings** — from the Age of Embers to the Age of Wonders.
- **Events & choices** — traders, refugees, sages, raiders, wolves, fevers, harsh winters, festivals and omens.
- **Guided goals** — a 17-step goal track walks new players from the first gatherer to victory.
- **Idle-friendly** — autosaves to `localStorage`; time away passes at half speed (up to 12 in-game years) with a
  "while you were away" summary. Export/import saves as text.
- **Pixel art & juice** — all sprites are hand-authored in code (no external assets): walking settlers carrying goods,
  deer and sheep, jumping fish, birds, campfire flames and smoke, seasonal trees and snow, construction that rises from
  its scaffolding, and synthesized sound effects.
- Works with mouse, keyboard and touch; responsive down to phone size.

## Controls

| Action | Input |
| --- | --- |
| Pan / zoom | drag · mouse wheel / pinch · `WASD` / arrows · `+` `-` |
| Pause / speed | `Space` · `1` `2` `3` |
| Centre on hearth | `H` |
| Tabs | `P` people · `B` build · `R` research · `C` chronicle |
| Place several buildings / change jobs by 5 | hold `Shift` |
| Cancel / menu | `Esc` or right-click |

## Development

```bash
npm install
npm run dev        # http://localhost:5173  (add ?dev for debug hooks and a 20× speed on key 4)
npm test           # unit tests + balance playthroughs
npm run build      # static build in dist/
npm run preview
```

The build is fully static (relative paths), so `dist/` can be hosted anywhere. The included
`.github/workflows/deploy.yml` publishes to GitHub Pages on pushes to `main` (enable Pages → "GitHub Actions" in the
repository settings).

### Project layout

```
src/game/      pure simulation — no DOM
  data.ts        all tunable content: jobs, buildings, techs, eras, goals
  map.ts         seeded world generation
  sim.ts         the daily tick: production, consumption, construction, exploration, births, deaths, morale
  events.ts      random events and player choices
  actions.ts     everything the player can do
  save.ts        save/load, export, offline progress
src/render/    canvas renderer: sprites, seasonal terrain, camera/input, settlers & particles
src/ui/        DOM interface: HUD, panels, inspector, goals, modals, tooltips, audio
tests/         unit tests and a heuristic bot (autoplayer.ts) that plays whole games
```

### Balance

`tests/balance.test.ts` has a simple bot play complete games on several seeds through the same actions a player uses,
and asserts every run reaches victory without the settlement dying out. Run more seeds with
`BAL_SEEDS=1,2,3 npm run balance`, or trace a single game year by year with
`TRACE_SEED=42 TRACE_YEARS=30 npx vitest run tests/trace.test.ts --reporter=verbose`.
