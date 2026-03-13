# B787 Performance Web App

This app reproduces your Excel calculators in a browser UI and is configured as a PWA (installable + offline + saved inputs):

- Short Trip Fuel
- Long Range Cruise
  - Includes FRF (30 min hold at 1500 ft using landing weight), contingency (5% min 350 max 1200), and user-entered additional holding minutes
- Diversion (LRC)
  - GNM to ANM conversion with headwind/tailwind table
  - Fuel/time interpolation by ANM and altitude
  - Fuel adjustment by reference fuel and start weight
  - Clamped-to-edge behavior for out-of-range inputs
- Holding + Endurance
- Lose Time Enroute
- Lose Time strategy comparison:
  - Option A: continue LRC then hold at fix
  - Option B: reduce to hold speed before fix to absorb delay enroute
  - Dynamic fuel burn with 1-minute integration and weight-updated interpolation
  - Optional one-time climb/descent after user-entered elapsed minutes
  - Enroute hold-speed phase uses a 5% fuel reduction vs pattern holding fuel flow
- Endurance Available
- IAS / Mach / TAS conversion (ICAO ISA + compressible flow model)
  - Altitude source: FL
  - Temperature source: direct OAT or ISA deviation

## Run

Serve the folder over HTTP (required for service worker/PWA):

```bash
cd /Users/russellgillson/Documents/MyApps/787\ Perf\ Calculators
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Install As App (Desktop + iPhone/iPad)

Desktop (Chrome/Edge):
1. Open the HTTPS app URL.
2. Use the browser install button (`Install app`) in the address bar/menu.
3. Launch from desktop/start menu like a native app.

iPhone/iPad (Safari):
1. Open the HTTPS app URL.
2. Tap `Share` -> `Add to Home Screen`.
3. Launch once while online so assets are cached by the service worker.
4. After that, it can run offline from the Home Screen app.

## Input Persistence (Local Storage)

- All inputs across modules are saved locally in browser storage as you type/change/submit.
- On next launch, the app restores the last entered values before calculations run.
- If browser/site data is fully cleared for the app origin, saved values are removed by the browser.

## Global Setting

- `Flight Plan Performance Adjustment` is entered once (global) and applied to all fuel-related calculators.

## Data Source Mapping

Spreadsheet source file: `/Users/russellgillson/Desktop/B787_Calculators Final.xlsx`

- `Tables!A3:K14` -> Short-trip GNM/ANM wind conversion
- `Tables!A18:L37` -> Long-range GNM/ANM conversion
- `Tables!A41:G60` -> Long-range flight fuel + time
- `Tables!A74:L85` -> Short-trip fuel/alt/time
- `Tables!M3:Q72` -> Holding IAS/TAS/FF_ENG lookup data

Raw extracted ranges are preserved in:

- `/Users/russellgillson/Documents/New project/extracted_data.json`
- `/Users/russellgillson/Documents/New project/lrc_data.js`
- `/Users/russellgillson/Documents/New project/flaps_up_data.js`
- `/Users/russellgillson/Documents/New project/diversion_data.js`

Diversion tables source file: `/Users/russellgillson/Desktop/flight_planning_tables.xlsx`

## IAS/Mach/TAS Model

The IAS/Mach/TAS calculator does **not** use the spreadsheet equation.
It uses:

- Layered ISA-1976 pressure model (geopotential altitude basis)
- Pressure altitude derived from FL
- Actual OAT or ISA deviation for local speed of sound
- Compressible subsonic pitot-static relations to convert IAS(CAS)-Mach-TAS

This is materially more accurate than the spreadsheet approximation across altitude.
