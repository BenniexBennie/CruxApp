# Training Plan

A climbing and strength training log you can install on your phone. It's one HTML file with no build step.

**Live app:** https://benniexbennie.github.io/CruxApp/
On iPhone, open it in Safari, tap Share, then **Add to Home Screen**.

## What it does

- **Week tab:** schedule exercises from the library for each day.
  - Set a target set by set, then log what you actually did. Ticking a box logs it as planned.
  - Link exercises into supersets or circuits (A1/A2 tags) from any exercise's pop-up.
  - Track lifting time, a daily check-in (fingers, skin, energy) and load warnings.
  - Switch to the Month calendar for an overview. Bodyweight is logged in the check-in.
- **Plan tab:** goals, habits (quit, cut back or build: yes/no or a count, logged on the Week tab), repeatable sessions (shareable by link) and boulder projects.
- **Data tab:** training time per week, V grades, habit streaks, a grade pyramid, exercise progress (in lb or % of bodyweight), personal records, bodyweight and check-in averages.
- **Library:** your exercises by category. Weights are in lb, edges in mm, distance in miles and elevation in feet.
- **Timer:** ⏱ in any exercise opens a rest countdown or hang repeaters.

## Where data lives

Data is saved in the browser's `localStorage` under the key `crux.v1`.
- **Sync with GitHub:** in Settings, your data is kept in a private gist and synced between devices. You need a token with only the `gist` scope. The newest change wins.
- **Export backup:** saves a JSON file.
- **Offline:** a service worker (`sw.js`) keeps a copy so the app opens without a connection.

## Development

Edit `index.html`, then bump `APP_VERSION` so installed copies update themselves.

Tests use Playwright. They serve the app from a fake GitHub Pages URL and mock the GitHub API:

```sh
cd tests
npm install
npm test
```
