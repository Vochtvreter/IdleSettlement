# Hearthlands — an idle settlement saga

Lead eight wanderers from a single campfire to a civilisation that raises **the Sunspire**, a wonder for the ages.

**You decide. The game runs.** A council runs the settlement day to day: it assigns work, raises buildings and pursues
discoveries, even while you are away. Your progress comes from the decisions you make, and nothing ever pauses to wait
for you. Each age is entered by choosing one of three permanent paths, and new policies and council settings unlock as
your settlement reaches milestones.

A full playthrough takes roughly **25–40 minutes at normal speed** (2× and 5× speeds are available), depending on your
choices, and there is a New Game+ "Legacy" loop afterwards.

## A gentle start

The game introduces itself one system at a time. A new settlement starts with only the Decide tab and a single
choice, the Founding Way. The People, Build, Chronicle and Research tabs, Council Focus, policies, council settings
and manual control each appear once they start to matter, and short tips from the elder explain each one as it opens
up. Tips can be switched off from the menu.

## Decisions

- **Crossroads (paths).** Choose your people's Founding Way at any time. When the settlement is ready for a new age
  (enough people, key discoveries, stored resources), a Crossroads opens. Pick one of three permanent paths to enter the
  age, e.g. *Tillers of the Soil*, *Herders of the Plain* or *The Wanderers' Road*. The four ages after the first are
  only reached this way. Until you choose, the settlement keeps living and growing, but it stays in its current age.
- **Council focus.** Balanced, Growth, Industry, Knowledge or Exploration. This shapes how the council staffs jobs,
  what it builds and which discoveries it pursues.
- **Policies.** These are trade-offs: Rations, Working Hours, Strangers, Families, Forestry, Festivals, Militia,
  Markets, Laws and Public Works. Each unlocks at a milestone and can be changed once per season.
- **Council settings.** These unlock over time: winter food reserve, spare homes, number of scouts and builder share.
  You can also pick which discovery the council researches next.
- **Events.** Traders, refugees, sages and raiders offer choices. If you ignore them, your people pick the cautious
  option after a few days.
- **Manual control (optional).** Hand any of work, construction or research back to yourself, commission buildings
  on specific tiles, and click the map to send scouts.

## World features

- **Living population.** Every settler has a name, age, generation and job. Births need free housing, food and good
  morale; people die of old age, illness, hunger, cold, wolves or raids.
- **Seasons.** Winter brings poor foraging, no harvest and a need for firewood.
- **Interactive map.** Procedurally generated terrain (rivers, coasts, forests, hills, mountains) with fog of war.
  Adjacency matters: lumber camps go by forests, farms by water and mines on ore veins.
- **Exploration.** Ruins, supply caches, wanderer camps that join you, sacred groves, game herds and ore veins.
- **Idle-friendly.** The game autosaves. Time away passes at half speed (up to 12 in-game years) with a summary of
  what happened, and the council keeps working the whole time. Saves can be exported and imported as text.
- **Pixel art.** All sprites are hand-authored in code, with synthesized sound effects, and the layout is responsive
  down to phone size.

## Controls

| Action | Input |
| --- | --- |
| Pan / zoom | drag · mouse wheel / pinch · `WASD` / arrows · `+` `-` |
| Pause / speed | `Space` · `1` `2` `3` |
| Centre on hearth | `H` |
| Tabs | `E` decide · `P` people · `B` build · `R` research · `C` chronicle |
| Commission several buildings / change jobs by 5 (manual mode) | hold `Shift` |
| Cancel / menu | `Esc` or right-click |

## Development

```bash
npm install
npm run dev        # http://localhost:5173  (add ?dev for debug hooks and a 20× speed on key 4)
npm test           # unit tests + balance playthroughs
npm run build      # static build in dist/
npm run preview
```

The build is fully static with relative paths, so `dist/` can be hosted anywhere.

### Publishing on GitHub Pages

`.github/workflows/deploy.yml` builds the game and publishes it whenever `main` or the repository's default branch
changes. One-time setup: in the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**. Then
push to `main`, or open **Actions → Deploy to GitHub Pages → Run workflow**. The game will be live at
`https://<user>.github.io/<repo>/`.

If the browser console shows `GET https://<user>.github.io/src/main.ts 404`, Pages is set to **Deploy from a branch**
and is serving the unbuilt source. Switch **Source** to **GitHub Actions** and run the workflow again.

### Project layout

```
src/game/      pure simulation — no DOM
  data.ts        tunable content: jobs, buildings, techs, eras
  decisions.ts   paths, focus, policies, council settings, milestones and their effects
  reveal.ts      when each tab and section of the interface appears
  guide.ts       the elder's tips that introduce each system
  council.ts     the automation that runs the settlement according to your decisions
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

`tests/balance.test.ts` plays whole games where the council runs everything and a scripted player only makes
decisions, choosing each path as soon as it is offered. Every run must reach victory without the settlement dying out,
and a run with no decisions must survive but stay in the first age. Run more seeds with
`BAL_SEEDS=1,2,3 npm run balance`, or trace a single game year by year with
`TRACE_SEED=42 TRACE_YEARS=30 npx vitest run tests/trace.test.ts --reporter=verbose`.
