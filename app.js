const TABLE_DATA = window.TABLE_DATA;
const LRC_CRUISE_TABLE = window.LRC_CRUISE_TABLE;
const LRC_ALTITUDE_LIMITS_TABLE = window.LRC_ALTITUDE_LIMITS_TABLE;
const DRIFTDOWN_TABLE = window.DRIFTDOWN_TABLE;
const EO_DIVERSION_TABLE = window.EO_DIVERSION_TABLE;
const FLAPS_UP_TABLE = window.FLAPS_UP_TABLE;
const DIVERSION_LRC_TABLE = window.DIVERSION_LRC_TABLE;
const GO_AROUND_TABLE = window.GO_AROUND_TABLE;

const { shortTripAnm, longRangeAnm, longRangeFuel: longRangeFuelTable, shortTripFuelAlt } = TABLE_DATA;
const APP_VERSION = "v7.3.0";
const INPUT_STATE_STORAGE_KEY = "performance-calculators-input-state-v1";

const R_AIR = 287.05287;
const GAMMA = 1.4;
const G0 = 9.80665;
const T0 = 288.15;
const P0 = 101325;
const FT_TO_M = 0.3048;
const M_TO_FT = 1 / FT_TO_M;
const MPS_TO_KT = 1.94384449244;
const KT_TO_MPS = 0.51444444444;
const EARTH_RADIUS_M = 6356766;
const A0 = Math.sqrt(GAMMA * R_AIR * T0);
const ISA_LAYER_BASES_M = [0, 11000, 20000, 32000, 47000];
const ISA_LAYER_LAPSE_RATES = [-0.0065, 0, 0.001, 0.0028, 0];
const ISA_BASES = buildIsaBases();
const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;
const DEFAULT_HOLD_BANK_DEG = 25;
const FIXED_ALLOWANCE_KG = 200;
const MIN_CONTINGENCY_KG = 350;
const MAX_CONTINGENCY_KG = 1200;
const FRF_HOLD_ALTITUDE_FT = 1500;
const ADDITIONAL_HOLD_ALTITUDE_FT = 20000;
const ENROUTE_HOLD_SPEED_FUEL_FACTOR = 0.95;
const LOSE_TIME_CLIMB_RATE_FPM = 1000;
const LOSE_TIME_DESCENT_RATE_FPM = 1000;
const GO_AROUND_ANTI_ICE_ADJUSTMENT = {
  engineOn: { oatLe8: -0.1, oatGt8Le20: -0.2 },
  engineWingOn: { oatLe8: -0.1, oatGt8Le20: -0.2 },
};

function parseNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function parseAltOrFlInput(rawInput, label = "Alt/FL") {
  const rawText = String(rawInput ?? "").trim();
  if (rawText === "") {
    throw new Error(`${label} must be entered`);
  }

  const value = Number(rawText);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be > 0`);
  }

  // Rule: exactly 3-digit integer input is FL, otherwise feet.
  const absValue = Math.abs(value);
  const integerDigits = Math.trunc(absValue).toString().length;
  const isThreeDigitFl = Number.isInteger(value) && integerDigits === 3;
  const altitudeFt = isThreeDigitFl ? value * 100 : value;
  const flightLevel = altitudeFt / 100;

  return {
    rawText,
    value,
    isThreeDigitFl,
    altitudeFt,
    flightLevel,
  };
}

function normalizeFlightLevelInput(rawInput, label = "Alt/FL") {
  return parseAltOrFlInput(rawInput, label).flightLevel;
}

function normalizeAltitudeFtInput(rawInput, label = "Alt/FL") {
  return parseAltOrFlInput(rawInput, label).altitudeFt;
}

function getIsaTempCAtPressureAltitude(pressureAltitudeFt) {
  const isaAtmosphere = atmosphereFromPressureAltitude({
    pressureAltitudeFt,
    tempMode: "isa-dev",
    isaDeviationC: 0,
    oatC: 0,
  });
  return isaAtmosphere.isaTempK - 273.15;
}

function resolveTemperaturePair({ isaDeviationRaw, temperatureRaw, lastSource = "isa-dev", pressureAltitudeFt, label = "Temperature" }) {
  const isaText = String(isaDeviationRaw ?? "").trim();
  const tempText = String(temperatureRaw ?? "").trim();

  let sourceUsed;
  if (isaText !== "" && tempText === "") {
    sourceUsed = "isa-dev";
  } else if (tempText !== "" && isaText === "") {
    sourceUsed = "temp";
  } else if (isaText !== "" && tempText !== "") {
    sourceUsed = lastSource === "temp" ? "temp" : "isa-dev";
  } else {
    throw new Error(`${label}: enter ISA deviation or Temperature`);
  }

  const isaTempC = getIsaTempCAtPressureAltitude(pressureAltitudeFt);
  let isaDeviationC;
  let temperatureC;
  if (sourceUsed === "isa-dev") {
    isaDeviationC = parseNum(isaText);
    if (!Number.isFinite(isaDeviationC)) {
      throw new Error(`${label}: ISA deviation is invalid`);
    }
    temperatureC = isaTempC + isaDeviationC;
  } else {
    temperatureC = parseNum(tempText);
    if (!Number.isFinite(temperatureC)) {
      throw new Error(`${label}: temperature is invalid`);
    }
    isaDeviationC = temperatureC - isaTempC;
  }

  return {
    sourceUsed,
    isaDeviationC,
    temperatureC,
    isaTempC,
  };
}

function applyTemperatureFieldStyle({ sourceUsed, isaDeviationEl, temperatureEl }) {
  if (isaDeviationEl) {
    isaDeviationEl.classList.toggle("auto-derived", sourceUsed === "temp");
  }
  if (temperatureEl) {
    temperatureEl.classList.toggle("auto-derived", sourceUsed === "isa-dev");
  }
}

function userFlToTableFl(flightLevel) {
  return flightLevel >= 100 ? flightLevel / 10 : flightLevel;
}

function getLrcTableFlRange() {
  if (!LRC_CRUISE_TABLE || !Array.isArray(LRC_CRUISE_TABLE.altitudesFL) || LRC_CRUISE_TABLE.altitudesFL.length < 2) {
    return { minFl: NaN, maxFl: NaN };
  }
  return {
    minFl: LRC_CRUISE_TABLE.altitudesFL[0] * 10,
    maxFl: LRC_CRUISE_TABLE.altitudesFL[LRC_CRUISE_TABLE.altitudesFL.length - 1] * 10,
  };
}

function getDiversionAltitudeRangeFt() {
  if (!DIVERSION_LRC_TABLE) return { minFt: NaN, maxFt: NaN };
  const altitudeArrays = [];
  if (DIVERSION_LRC_TABLE.low?.fuelTime?.altitudeAxisFt) {
    altitudeArrays.push(DIVERSION_LRC_TABLE.low.fuelTime.altitudeAxisFt);
  }
  if (DIVERSION_LRC_TABLE.high?.fuelTime?.altitudeAxisFt) {
    altitudeArrays.push(DIVERSION_LRC_TABLE.high.fuelTime.altitudeAxisFt);
  }
  if (DIVERSION_LRC_TABLE.fuelTime?.altitudeAxisFt) {
    altitudeArrays.push(DIVERSION_LRC_TABLE.fuelTime.altitudeAxisFt);
  }
  if (altitudeArrays.length === 0) return { minFt: NaN, maxFt: NaN };

  const mins = altitudeArrays.map((a) => a[0]).filter(Number.isFinite);
  const maxs = altitudeArrays.map((a) => a[a.length - 1]).filter(Number.isFinite);
  if (mins.length === 0 || maxs.length === 0) return { minFt: NaN, maxFt: NaN };
  return {
    minFt: Math.min(...mins),
    maxFt: Math.max(...maxs),
  };
}

function getLrcAltitudeLimitsRanges() {
  if (!LRC_ALTITUDE_LIMITS_TABLE) {
    return {
      minWeightT: NaN,
      maxWeightT: NaN,
      minIsaDevC: NaN,
      maxIsaDevC: NaN,
      minOptimumAltFt: NaN,
      maxOptimumAltFt: NaN,
    };
  }
  const weightAxis = LRC_ALTITUDE_LIMITS_TABLE.weightAxisT || [];
  const isaAxis = LRC_ALTITUDE_LIMITS_TABLE.isaDeviationAxisC || [];
  const optimumGrid = LRC_ALTITUDE_LIMITS_TABLE.optimumAltFtValues || [];
  const flatOptimum = optimumGrid.flat().filter(Number.isFinite);
  return {
    minWeightT: weightAxis[0],
    maxWeightT: weightAxis[weightAxis.length - 1],
    minIsaDevC: isaAxis[0],
    maxIsaDevC: isaAxis[isaAxis.length - 1],
    minOptimumAltFt: flatOptimum.length ? Math.min(...flatOptimum) : NaN,
    maxOptimumAltFt: flatOptimum.length ? Math.max(...flatOptimum) : NaN,
  };
}

function validateLrcFlightLevelRange(flightLevel, label = "Flight level") {
  const { minFl, maxFl } = getLrcTableFlRange();
  if (!Number.isFinite(minFl) || !Number.isFinite(maxFl)) return;
  if (flightLevel < minFl || flightLevel > maxFl) {
    throw new Error(`${label} out of range (FL${format(minFl, 0)}-FL${format(maxFl, 0)})`);
  }
}

function getGlobalPerfAdjust() {
  const el = document.querySelector("#global-perf-adjust");
  const perfAdjustPercent = parseNum(el?.value);
  if (!Number.isFinite(perfAdjustPercent)) {
    throw new Error("Global flight plan performance adjustment is invalid");
  }
  return perfAdjustPercent / 100;
}

function format(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function formatInputNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return "";
  const fixed = Number(value).toFixed(Math.max(0, digits));
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "-";
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  let m = Math.floor(abs % 60);
  let s = Math.round((abs - Math.floor(abs)) * 60);
  let hh = h;
  if (s === 60) {
    s = 0;
    m += 1;
  }
  if (m === 60) {
    m = 0;
    hh += 1;
  }
  return `${sign}${String(hh).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function normalize360(deg) {
  return ((deg % 360) + 360) % 360;
}

function toRadians(deg) {
  return deg * RAD_PER_DEG;
}

function toDegrees(rad) {
  return rad * DEG_PER_RAD;
}

function findBracket(axis, x) {
  if (x < axis[0] || x > axis[axis.length - 1]) {
    throw new Error(`Value ${x} is out of range ${axis[0]} to ${axis[axis.length - 1]}`);
  }

  if (x === axis[axis.length - 1]) {
    return { i0: axis.length - 2, i1: axis.length - 1, t: 1 };
  }

  for (let i = 0; i < axis.length - 1; i += 1) {
    const a = axis[i];
    const b = axis[i + 1];
    if (x >= a && x <= b) {
      const t = b === a ? 0 : (x - a) / (b - a);
      return { i0: i, i1: i + 1, t };
    }
  }

  throw new Error(`No interpolation bracket found for ${x}`);
}

function linear(axis, values, x) {
  const { i0, i1, t } = findBracket(axis, x);
  return values[i0] + (values[i1] - values[i0]) * t;
}

function bilinear(xAxis, yAxis, grid, x, y) {
  const bx = findBracket(xAxis, x);
  const by = findBracket(yAxis, y);

  const q11 = grid[bx.i0][by.i0];
  const q12 = grid[bx.i0][by.i1];
  const q21 = grid[bx.i1][by.i0];
  const q22 = grid[bx.i1][by.i1];

  return (
    q11 * (1 - bx.t) * (1 - by.t) +
    q21 * bx.t * (1 - by.t) +
    q12 * (1 - bx.t) * by.t +
    q22 * bx.t * by.t
  );
}

function interpolateAcrossWeight(weightAxis, valuesByWeight, weight) {
  const { i0, i1, t } = findBracket(weightAxis, weight);
  const lowerSeries = valuesByWeight[i0];
  const upperSeries = valuesByWeight[i1];
  return lowerSeries.map((v, idx) => v + (upperSeries[idx] - v) * t);
}

function shortTripAnmFromGnm(gnm, wind) {
  if (gnm < 50 || gnm > 600 || Math.abs(wind) > 100) {
    throw new Error("Short Trip ANM input out of range (GNM 50-600, wind +/-100)");
  }

  const gAxis = shortTripAnm.gnmAxis;

  if (wind === 0) return gnm;

  // Spreadsheet convention: positive wind is tailwind, negative wind is headwind.
  if (wind < 0) {
    const absWind = Math.abs(wind);
    if (absWind < 20) {
      const anmAt20 = linear(gAxis, shortTripAnm.headwindValues.map((row) => row[0]), gnm);
      return gnm + (anmAt20 - gnm) * (absWind / 20);
    }

    return bilinear(gAxis, shortTripAnm.headwindAxis, shortTripAnm.headwindValues, gnm, absWind);
  }

  if (wind < 20) {
    const anmAt20Tail = linear(gAxis, shortTripAnm.tailwindValues.map((row) => row[0]), gnm);
    return gnm + (anmAt20Tail - gnm) * (wind / 20);
  }

  return bilinear(gAxis, shortTripAnm.tailwindAxis, shortTripAnm.tailwindValues, gnm, wind);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampToAxis(axis, x) {
  return clamp(x, axis[0], axis[axis.length - 1]);
}

function linearClamped(axis, values, x) {
  return linear(axis, values, clampToAxis(axis, x));
}

function bilinearClamped(xAxis, yAxis, grid, x, y) {
  return bilinear(xAxis, yAxis, grid, clampToAxis(xAxis, x), clampToAxis(yAxis, y));
}

function evaluateLrcAltitudeLimits(weightT, isaDeviationCInput) {
  if (!LRC_ALTITUDE_LIMITS_TABLE) {
    throw new Error("LRC altitude limits table is missing");
  }
  if (!Number.isFinite(weightT) || weightT <= 0) {
    throw new Error("Weight must be > 0 t");
  }
  if (!Number.isFinite(isaDeviationCInput)) {
    throw new Error("Temperature / ISA deviation is invalid");
  }

  const isaAxis = LRC_ALTITUDE_LIMITS_TABLE.isaDeviationAxisC;
  const weightAxis = LRC_ALTITUDE_LIMITS_TABLE.weightAxisT;
  const minIsa = isaAxis[0];
  const maxIsa = isaAxis[isaAxis.length - 1];
  const isaDeviationCUsed = isaDeviationCInput < minIsa ? minIsa : isaDeviationCInput;
  if (isaDeviationCUsed > maxIsa) {
    throw new Error(`Temperature / ISA deviation out of range (ISA+${format(minIsa, 0)} to ISA+${format(maxIsa, 0)})`);
  }
  if (weightT < weightAxis[0] || weightT > weightAxis[weightAxis.length - 1]) {
    throw new Error(`Weight out of range (${format(weightAxis[0], 1)}-${format(weightAxis[weightAxis.length - 1], 1)} t)`);
  }

  const optimumAltFt = bilinear(
    isaAxis,
    weightAxis,
    LRC_ALTITUDE_LIMITS_TABLE.optimumAltFtValues,
    isaDeviationCUsed,
    weightT,
  );
  const maxAltFt = bilinear(
    isaAxis,
    weightAxis,
    LRC_ALTITUDE_LIMITS_TABLE.maxAltFtValues,
    isaDeviationCUsed,
    weightT,
  );
  const thrustMetric = bilinear(
    isaAxis,
    weightAxis,
    LRC_ALTITUDE_LIMITS_TABLE.thrustLimitedValues,
    isaDeviationCUsed,
    weightT,
  );

  return {
    weightT,
    isaDeviationCInput,
    isaDeviationCUsed,
    clampedToIsa10: isaDeviationCInput < minIsa,
    optimumAltFt,
    maxAltFt,
    thrustLimited: thrustMetric >= 0.5,
    thrustMetric,
  };
}

function buildOptimumAltitudeByWeightAtIsa(isaDeviationCUsed) {
  const isaAxis = LRC_ALTITUDE_LIMITS_TABLE.isaDeviationAxisC;
  const weightAxis = LRC_ALTITUDE_LIMITS_TABLE.weightAxisT;
  const grid = LRC_ALTITUDE_LIMITS_TABLE.optimumAltFtValues;

  return weightAxis.map((_, weightIndex) =>
    linear(
      isaAxis,
      grid.map((row) => row[weightIndex]),
      isaDeviationCUsed,
    ),
  );
}

function weightForNominatedOptimumAltitude(targetOptimumAltFt, isaDeviationCUsed) {
  if (!Number.isFinite(targetOptimumAltFt) || targetOptimumAltFt <= 0) {
    throw new Error("New Optimum Altitude must be > 0");
  }
  const weightAxis = LRC_ALTITUDE_LIMITS_TABLE.weightAxisT;
  const optimumByWeight = buildOptimumAltitudeByWeightAtIsa(isaDeviationCUsed);
  const minOpt = Math.min(...optimumByWeight);
  const maxOpt = Math.max(...optimumByWeight);
  if (targetOptimumAltFt < minOpt || targetOptimumAltFt > maxOpt) {
    throw new Error(
      `New Optimum Altitude out of range (${format(minOpt, 0)}-${format(maxOpt, 0)} ft / FL${format(minOpt / 100, 0)}-FL${format(maxOpt / 100, 0)})`,
    );
  }

  // Search from heaviest to lightest so flat-top altitudes resolve to the earliest reachable weight.
  for (let i = weightAxis.length - 1; i >= 1; i -= 1) {
    const wHeavy = weightAxis[i];
    const wLight = weightAxis[i - 1];
    const aHeavy = optimumByWeight[i];
    const aLight = optimumByWeight[i - 1];
    const lowAlt = Math.min(aHeavy, aLight);
    const highAlt = Math.max(aHeavy, aLight);
    if (targetOptimumAltFt >= lowAlt && targetOptimumAltFt <= highAlt) {
      if (aLight === aHeavy) {
        return wHeavy;
      }
      const t = (targetOptimumAltFt - aHeavy) / (aLight - aHeavy);
      return wHeavy + (wLight - wHeavy) * t;
    }
  }

  return weightAxis[0];
}

function simulateStepClimbFuelToTargetWeight({
  startWeightT,
  targetWeightT,
  startFlightLevel,
  targetOptimumAltFt,
  isaDeviationCUsed,
  perfAdjust,
}) {
  if (!Number.isFinite(startWeightT) || !Number.isFinite(targetWeightT)) {
    throw new Error("Weight input is invalid for step-climb simulation");
  }
  if (!Number.isFinite(startFlightLevel) || startFlightLevel <= 0) {
    throw new Error("Current Alt/FL is invalid for step-climb simulation");
  }
  if (!Number.isFinite(targetOptimumAltFt) || targetOptimumAltFt <= 0) {
    throw new Error("New Optimum Altitude is invalid for step-climb simulation");
  }
  const cruiseWeightAxis = (LRC_CRUISE_TABLE?.records || [])
    .map((record) => record.weightT)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const minCruiseWeightT = cruiseWeightAxis[0];
  const maxCruiseWeightT = cruiseWeightAxis[cruiseWeightAxis.length - 1];
  if (!Number.isFinite(minCruiseWeightT) || !Number.isFinite(maxCruiseWeightT)) {
    throw new Error("LRC cruise weight axis is unavailable");
  }
  if (startWeightT < minCruiseWeightT || startWeightT > maxCruiseWeightT) {
    throw new Error(`Current weight out of range for LRC fuel-flow lookup (${format(minCruiseWeightT, 1)}-${format(maxCruiseWeightT, 1)} t)`);
  }

  const startAltitudeFt = startFlightLevel * 100;
  const burnRequiredKg = Math.max(0, (startWeightT - targetWeightT) * 1000);
  const transitions = [];
  const firstStepAltitudeFt = Math.floor(startAltitudeFt / 1000) * 1000 + 1000;
  const maxStepAltitudeFt = Math.floor(targetOptimumAltFt / 1000) * 1000;
  for (let stepAltitudeFt = firstStepAltitudeFt; stepAltitudeFt <= maxStepAltitudeFt; stepAltitudeFt += 1000) {
    transitions.push({
      altitudeFt: stepAltitudeFt,
      thresholdWeightT: weightForNominatedOptimumAltitude(stepAltitudeFt, isaDeviationCUsed),
    });
  }

  let currentWeightT = startWeightT;
  let currentAltitudeFt = startAltitudeFt;
  let transitionIndex = 0;
  const stepClimbs = [];
  const applyEligibleClimbs = () => {
    while (
      transitionIndex < transitions.length &&
      currentWeightT <= transitions[transitionIndex].thresholdWeightT + 1e-9
    ) {
      currentAltitudeFt = transitions[transitionIndex].altitudeFt;
      stepClimbs.push({
        altitudeFt: currentAltitudeFt,
        atWeightT: currentWeightT,
      });
      transitionIndex += 1;
    }
  };

  applyEligibleClimbs();
  const initialFuelFlowKgHr = getLrcCruiseState(clamp(currentWeightT, minCruiseWeightT, maxCruiseWeightT), currentAltitudeFt / 100, 0, perfAdjust).fuelHr;
  if (burnRequiredKg <= 1e-6) {
    return {
      burnRequiredKg,
      timeMinutes: 0,
      averageFuelFlowKgHr: initialFuelFlowKgHr,
      initialFuelFlowKgHr,
      stepClimbs,
    };
  }

  const BURN_STEP_KG = 250;
  let burnedKg = 0;
  let elapsedHours = 0;

  while (burnedKg < burnRequiredKg - 1e-6) {
    applyEligibleClimbs();
    const lookupWeightT = clamp(currentWeightT, minCruiseWeightT, maxCruiseWeightT);
    const fuelFlowKgHr = getLrcCruiseState(lookupWeightT, currentAltitudeFt / 100, 0, perfAdjust).fuelHr;
    if (!Number.isFinite(fuelFlowKgHr) || fuelFlowKgHr <= 0) {
      throw new Error("Computed LRC fuel flow is invalid during step-climb simulation");
    }

    const remainingKg = burnRequiredKg - burnedKg;
    let nextSegmentLimitKg = remainingKg;
    if (transitionIndex < transitions.length && currentWeightT > transitions[transitionIndex].thresholdWeightT + 1e-9) {
      nextSegmentLimitKg = Math.min(nextSegmentLimitKg, (currentWeightT - transitions[transitionIndex].thresholdWeightT) * 1000);
    }
    if (nextSegmentLimitKg <= 1e-6) {
      applyEligibleClimbs();
      continue;
    }

    const stepBurnKg = Math.min(BURN_STEP_KG, nextSegmentLimitKg);
    const stepHours = stepBurnKg / fuelFlowKgHr;
    burnedKg += stepBurnKg;
    currentWeightT -= stepBurnKg / 1000;
    elapsedHours += stepHours;
  }

  return {
    burnRequiredKg,
    timeMinutes: elapsedHours * 60,
    averageFuelFlowKgHr: burnRequiredKg / elapsedHours,
    initialFuelFlowKgHr,
    stepClimbs,
  };
}

function getDriftdownRanges() {
  if (!DRIFTDOWN_TABLE) {
    return {
      minWeightT: NaN,
      maxWeightT: NaN,
      minIsaDevC: NaN,
      maxIsaDevC: NaN,
      minGnm: NaN,
      maxGnm: NaN,
      minWindKt: NaN,
      maxWindKt: NaN,
      minAnm: NaN,
      maxAnm: NaN,
    };
  }
  const startWeights = DRIFTDOWN_TABLE.levelOff?.startWeightAxisT || [];
  const isaAxis = DRIFTDOWN_TABLE.levelOff?.isaDeviationAxisC || [];
  const gnmAxis = DRIFTDOWN_TABLE.groundToAir?.gnmAxis || [];
  const windAxis = DRIFTDOWN_TABLE.groundToAir?.windAxis || [];
  const anmAxis = DRIFTDOWN_TABLE.fuelTime?.anmAxis || [];
  return {
    minWeightT: startWeights[0],
    maxWeightT: startWeights[startWeights.length - 1],
    minIsaDevC: isaAxis[0],
    maxIsaDevC: isaAxis[isaAxis.length - 1],
    minGnm: gnmAxis[0],
    maxGnm: gnmAxis[gnmAxis.length - 1],
    minWindKt: windAxis[0],
    maxWindKt: windAxis[windAxis.length - 1],
    minAnm: anmAxis[0],
    maxAnm: anmAxis[anmAxis.length - 1],
  };
}

function normalizeIsaDeviationForDriftdown(inputIsaDeviationC) {
  if (!Number.isFinite(inputIsaDeviationC)) {
    throw new Error("Temperature / ISA deviation is invalid");
  }
  const axis = DRIFTDOWN_TABLE.levelOff.isaDeviationAxisC;
  const minIsa = axis[0];
  const maxIsa = axis[axis.length - 1];
  const isaDeviationCUsed = inputIsaDeviationC < minIsa ? minIsa : inputIsaDeviationC;
  if (isaDeviationCUsed > maxIsa) {
    throw new Error(`Engine inop temperature / ISA deviation out of range (ISA+${format(minIsa, 0)} to ISA+${format(maxIsa, 0)})`);
  }
  return {
    isaDeviationCUsed,
    clampedToIsa10: inputIsaDeviationC < minIsa,
  };
}

function evaluateDriftdownLevelOff(startWeightT, isaDeviationCInput) {
  if (!DRIFTDOWN_TABLE) {
    throw new Error("Driftdown table is missing");
  }
  const { isaDeviationCUsed, clampedToIsa10 } = normalizeIsaDeviationForDriftdown(isaDeviationCInput);
  const weightAxis = DRIFTDOWN_TABLE.levelOff.startWeightAxisT;
  if (startWeightT < weightAxis[0] || startWeightT > weightAxis[weightAxis.length - 1]) {
    throw new Error(
      `Engine inop start weight out of range (${format(weightAxis[0], 1)}-${format(weightAxis[weightAxis.length - 1], 1)} t)`,
    );
  }

  const levelOffWeightT = linear(weightAxis, DRIFTDOWN_TABLE.levelOff.levelOffWeightValues, startWeightT);
  const optimumDriftdownKias = linear(weightAxis, DRIFTDOWN_TABLE.levelOff.optimumDriftdownKiasValues, startWeightT);
  const levelOffAltFt = bilinear(
    DRIFTDOWN_TABLE.levelOff.isaDeviationAxisC,
    weightAxis,
    DRIFTDOWN_TABLE.levelOff.levelOffAltFtValues,
    isaDeviationCUsed,
    startWeightT,
  );

  return {
    isaDeviationCUsed,
    clampedToIsa10,
    levelOffWeightT,
    optimumDriftdownKias,
    levelOffAltFt,
  };
}

function driftdownAnmFromGnm(gnm, windKt) {
  if (!DRIFTDOWN_TABLE) {
    throw new Error("Driftdown table is missing");
  }
  const gnmAxis = DRIFTDOWN_TABLE.groundToAir.gnmAxis;
  const windAxis = DRIFTDOWN_TABLE.groundToAir.windAxis;
  if (!Number.isFinite(gnm) || gnm < gnmAxis[0] || gnm > gnmAxis[gnmAxis.length - 1]) {
    throw new Error(`Driftdown GNM out of range (${format(gnmAxis[0], 0)}-${format(gnmAxis[gnmAxis.length - 1], 0)})`);
  }
  if (!Number.isFinite(windKt) || windKt < windAxis[0] || windKt > windAxis[windAxis.length - 1]) {
    throw new Error(`Driftdown wind out of range (${format(windAxis[0], 0)} to +${format(windAxis[windAxis.length - 1], 0)} kt)`);
  }

  if (windKt === 0) return gnm;

  if (windKt < 0) {
    const absWind = Math.abs(windKt);
    if (absWind < 20) {
      const anmAt20Headwind = linear(
        gnmAxis,
        DRIFTDOWN_TABLE.groundToAir.values.map((row) => row[4]),
        gnm,
      );
      return gnm + (anmAt20Headwind - gnm) * (absWind / 20);
    }
  } else if (windKt < 20) {
    const anmAt20Tailwind = linear(
      gnmAxis,
      DRIFTDOWN_TABLE.groundToAir.values.map((row) => row[5]),
      gnm,
    );
    return gnm + (anmAt20Tailwind - gnm) * (windKt / 20);
  }

  return bilinear(
    gnmAxis,
    windAxis,
    DRIFTDOWN_TABLE.groundToAir.values,
    gnm,
    windKt,
  );
}

function driftdownFuelAndTime(anm, startWeightT, perfAdjust) {
  if (!DRIFTDOWN_TABLE) {
    throw new Error("Driftdown table is missing");
  }
  const anmAxis = DRIFTDOWN_TABLE.fuelTime.anmAxis;
  const weightAxis = DRIFTDOWN_TABLE.fuelTime.weightAxisT;
  if (!Number.isFinite(anm) || anm < anmAxis[0] || anm > anmAxis[anmAxis.length - 1]) {
    throw new Error(`Driftdown ANM out of range (${format(anmAxis[0], 0)}-${format(anmAxis[anmAxis.length - 1], 0)})`);
  }
  if (!Number.isFinite(startWeightT) || startWeightT < weightAxis[0] || startWeightT > weightAxis[weightAxis.length - 1]) {
    throw new Error(`Driftdown start weight out of range (${format(weightAxis[0], 1)}-${format(weightAxis[weightAxis.length - 1], 1)} t)`);
  }

  const fuel1000Kg = bilinear(
    anmAxis,
    weightAxis,
    DRIFTDOWN_TABLE.fuelTime.fuel1000KgValues,
    anm,
    startWeightT,
  );
  const timeMinutes = linear(anmAxis, DRIFTDOWN_TABLE.fuelTime.timeMinutesValues, anm);
  return {
    fuelKg: fuel1000Kg * 1000 * (1 + perfAdjust),
    timeMinutes,
  };
}

function singleEngineLrcCapabilityAltitude(startWeightT, isaDeviationCInput) {
  if (!DRIFTDOWN_TABLE) {
    throw new Error("Driftdown table is missing");
  }
  const { isaDeviationCUsed, clampedToIsa10 } = normalizeIsaDeviationForDriftdown(isaDeviationCInput);
  const weightAxis = DRIFTDOWN_TABLE.singleEngineLrcCapability.weightAxisT;
  if (!Number.isFinite(startWeightT) || startWeightT < weightAxis[0] || startWeightT > weightAxis[weightAxis.length - 1]) {
    throw new Error(
      `SE LRC capability weight out of range (${format(weightAxis[0], 1)}-${format(weightAxis[weightAxis.length - 1], 1)} t)`,
    );
  }

  const altitudeFt = bilinear(
    DRIFTDOWN_TABLE.singleEngineLrcCapability.isaDeviationAxisC,
    weightAxis,
    DRIFTDOWN_TABLE.singleEngineLrcCapability.altitudeFtValues,
    isaDeviationCUsed,
    startWeightT,
  );
  return {
    isaDeviationCUsed,
    clampedToIsa10,
    altitudeFt,
  };
}

function getEoDiversionRanges() {
  if (!EO_DIVERSION_TABLE) {
    return {
      minGnm: NaN,
      maxGnm: NaN,
      minWindKt: NaN,
      maxWindKt: NaN,
      minAnm: NaN,
      maxAnm: NaN,
      minAltitudeFt: NaN,
      maxAltitudeFt: NaN,
      minWeightT: NaN,
      maxWeightT: NaN,
    };
  }
  return {
    minGnm: EO_DIVERSION_TABLE.groundToAir.gnmAxis[0],
    maxGnm: EO_DIVERSION_TABLE.groundToAir.gnmAxis[EO_DIVERSION_TABLE.groundToAir.gnmAxis.length - 1],
    minWindKt: EO_DIVERSION_TABLE.groundToAir.windAxis[0],
    maxWindKt: EO_DIVERSION_TABLE.groundToAir.windAxis[EO_DIVERSION_TABLE.groundToAir.windAxis.length - 1],
    minAnm: EO_DIVERSION_TABLE.fuelTime.anmAxis[0],
    maxAnm: EO_DIVERSION_TABLE.fuelTime.anmAxis[EO_DIVERSION_TABLE.fuelTime.anmAxis.length - 1],
    minAltitudeFt: EO_DIVERSION_TABLE.fuelTime.altitudeAxisFt[0],
    maxAltitudeFt: EO_DIVERSION_TABLE.fuelTime.altitudeAxisFt[EO_DIVERSION_TABLE.fuelTime.altitudeAxisFt.length - 1],
    minWeightT: EO_DIVERSION_TABLE.fuelAdjustment.weightAxisT[0],
    maxWeightT: EO_DIVERSION_TABLE.fuelAdjustment.weightAxisT[EO_DIVERSION_TABLE.fuelAdjustment.weightAxisT.length - 1],
  };
}

function eoDiversionFuelTime(gnmInput, windInputKt, altitudeInputFt, weightInputT, perfAdjust) {
  if (!EO_DIVERSION_TABLE) {
    throw new Error("EO diversion table is missing");
  }
  if (
    !Number.isFinite(gnmInput) ||
    !Number.isFinite(windInputKt) ||
    !Number.isFinite(altitudeInputFt) ||
    !Number.isFinite(weightInputT)
  ) {
    throw new Error("EO diversion input is invalid");
  }
  if (!Number.isFinite(perfAdjust)) {
    throw new Error("Global flight plan performance adjustment is invalid");
  }

  const gnmAxis = EO_DIVERSION_TABLE.groundToAir.gnmAxis;
  const windAxis = EO_DIVERSION_TABLE.groundToAir.windAxis;
  const altAxis = EO_DIVERSION_TABLE.fuelTime.altitudeAxisFt;
  const weightAxis = EO_DIVERSION_TABLE.fuelAdjustment.weightAxisT;
  const gnmUsed = clampToAxis(gnmAxis, gnmInput);
  const windUsedKt = clampToAxis(windAxis, windInputKt);
  const altitudeUsedFt = clampToAxis(altAxis, altitudeInputFt);
  const weightUsedT = clampToAxis(weightAxis, weightInputT);

  const warnings = [];
  if (gnmUsed !== gnmInput) warnings.push(`EO diversion distance clamped to ${format(gnmUsed, 0)} NM`);
  if (windUsedKt !== windInputKt) warnings.push(`EO diversion wind clamped to ${format(windUsedKt, 0)} kt`);
  if (altitudeUsedFt !== altitudeInputFt) warnings.push(`EO diversion altitude clamped to ${format(altitudeUsedFt, 0)} ft`);
  if (weightUsedT !== weightInputT) warnings.push(`EO diversion weight clamped to ${format(weightUsedT, 1)} t`);

  const anm = Math.abs(windUsedKt) < 1e-9
    ? gnmUsed
    : bilinearClamped(
        EO_DIVERSION_TABLE.groundToAir.gnmAxis,
        EO_DIVERSION_TABLE.groundToAir.windAxis,
        EO_DIVERSION_TABLE.groundToAir.values,
        gnmUsed,
        windUsedKt,
      );

  const referenceFuel1000Kg = bilinearClamped(
    EO_DIVERSION_TABLE.fuelTime.anmAxis,
    EO_DIVERSION_TABLE.fuelTime.altitudeAxisFt,
    EO_DIVERSION_TABLE.fuelTime.fuel1000KgValues,
    anm,
    altitudeUsedFt,
  );
  const timeMinutes = bilinearClamped(
    EO_DIVERSION_TABLE.fuelTime.anmAxis,
    EO_DIVERSION_TABLE.fuelTime.altitudeAxisFt,
    EO_DIVERSION_TABLE.fuelTime.timeMinutesValues,
    anm,
    altitudeUsedFt,
  );
  const adjustment1000Kg = bilinearClamped(
    EO_DIVERSION_TABLE.fuelAdjustment.referenceFuelAxis1000Kg,
    EO_DIVERSION_TABLE.fuelAdjustment.weightAxisT,
    EO_DIVERSION_TABLE.fuelAdjustment.adjustment1000KgValues,
    referenceFuel1000Kg,
    weightUsedT,
  );
  const flightFuel1000Kg = (referenceFuel1000Kg + adjustment1000Kg) * (1 + perfAdjust);

  return {
    anm,
    referenceFuel1000Kg,
    adjustment1000Kg,
    flightFuel1000Kg,
    flightFuelKg: flightFuel1000Kg * 1000,
    timeMinutes,
    usedInputs: {
      gnm: gnmUsed,
      windKt: windUsedKt,
      altitudeFt: altitudeUsedFt,
      weightT: weightUsedT,
    },
    warnings,
  };
}

function getGoAroundConfig(flapSelection) {
  if (!GO_AROUND_TABLE) {
    throw new Error("Go-around table is missing");
  }
  const key = String(flapSelection) === "5" ? "flap5" : "flap20";
  const config = GO_AROUND_TABLE[key];
  if (!config) {
    throw new Error("Invalid flap selection");
  }
  return config;
}

function getGoAroundRanges(config) {
  return {
    minOatC: config.reference.oatAxisC[0],
    maxOatC: config.reference.oatAxisC[config.reference.oatAxisC.length - 1],
    minAltitudeFt: config.reference.altitudeAxisFt[0],
    maxAltitudeFt: config.reference.altitudeAxisFt[config.reference.altitudeAxisFt.length - 1],
    minWeightT: config.weightAdjustment.weightAxisT[0],
    maxWeightT: config.weightAdjustment.weightAxisT[config.weightAdjustment.weightAxisT.length - 1],
  };
}

function lookupGoAroundReferenceGradient(config, oatC, elevationFt) {
  const oatAxis = config.reference.oatAxisC;
  const altitudeAxis = config.reference.altitudeAxisFt;
  const grid = config.reference.gradientPctByOatAlt;

  const byAltitude = altitudeAxis.map((_, altitudeIdx) => {
    const valuesByOat = grid.map((row) => row[altitudeIdx]);
    return interpolateFromAvailablePointsClamped(oatAxis, valuesByOat, oatC, "go-around reference gradient");
  });

  return interpolateFromAvailablePointsClamped(altitudeAxis, byAltitude, elevationFt, "go-around reference gradient");
}

function lookupGoAroundWeightAdjustment(config, landingWeightT, referenceGradientPct) {
  const profile = buildGoAroundWeightAdjustmentProfile(config, referenceGradientPct);
  return linearClamped(profile.weightAxis, profile.adjustmentByWeightPct, landingWeightT);
}

function buildGoAroundWeightAdjustmentProfile(config, referenceGradientPct) {
  const gradientAxis = config.weightAdjustment.gradientAxisPct;
  const weightAxis = config.weightAdjustment.weightAxisT;
  const adjustmentByWeightPct = config.weightAdjustment.adjustmentPctByWeightGradient.map((row) =>
    linearClamped(gradientAxis, row, referenceGradientPct),
  );
  return { weightAxis, adjustmentByWeightPct };
}

function solveGoAroundWeightForTargetGradient({
  config,
  referenceGradientPct,
  baseGradientWithoutWeightPct,
  targetGradientPct,
}) {
  const profile = buildGoAroundWeightAdjustmentProfile(config, referenceGradientPct);
  const requiredWeightAdjustmentPct = targetGradientPct - baseGradientWithoutWeightPct;
  const landingWeightT = interpolateFromAvailablePointsClamped(
    profile.adjustmentByWeightPct,
    profile.weightAxis,
    requiredWeightAdjustmentPct,
    "go-around weight solution",
  );
  const appliedWeightAdjustmentPct = linearClamped(profile.weightAxis, profile.adjustmentByWeightPct, landingWeightT);
  return {
    landingWeightT,
    requiredWeightAdjustmentPct,
    appliedWeightAdjustmentPct,
  };
}

function getGoAroundSpeedRow(config, speedLabel) {
  const row = config.speedAdjustment.rows.find((item) => item.speed === speedLabel);
  if (!row) {
    throw new Error(`Invalid speed selection: ${speedLabel}`);
  }
  return row;
}

function lookupGoAroundSpeedAdjustment(config, speedLabel, referenceGradientPct) {
  const speedRow = getGoAroundSpeedRow(config, speedLabel);
  return linearClamped(config.speedAdjustment.gradientAxisPct, speedRow.adjustments, referenceGradientPct);
}

function lookupGoAroundAntiIceAdjustment(_config, antiIceMode, oatC) {
  if (antiIceMode === "off") return 0;
  const antiIceData = GO_AROUND_ANTI_ICE_ADJUSTMENT[antiIceMode];
  if (!antiIceData) {
    throw new Error("Invalid anti-ice selection");
  }
  if (oatC <= 8) return antiIceData.oatLe8;
  if (oatC <= 20) return antiIceData.oatGt8Le20;
  return 0;
}

function getGoAroundAntiIceBand(oatC) {
  if (oatC <= 8) return "OAT <= 8°C";
  if (oatC <= 20) return "8°C < OAT <= 20°C";
  return "OAT > 20°C";
}

function calculateGoAroundGradient({
  flapSelection,
  oatCInput,
  elevationFtInput,
  landingWeightTInput,
  targetGradientPctInput,
  speedLabel,
  antiIceMode,
  applyIcingPenalty,
}) {
  const config = getGoAroundConfig(flapSelection);
  const ranges = getGoAroundRanges(config);

  if (!Number.isFinite(oatCInput)) throw new Error("OAT is invalid");
  if (!Number.isFinite(elevationFtInput)) throw new Error("Airport elevation is invalid");
  const hasLandingWeightInput = Number.isFinite(landingWeightTInput);
  const hasTargetGradientInput = Number.isFinite(targetGradientPctInput);
  if (!hasLandingWeightInput && !hasTargetGradientInput) {
    throw new Error("Enter Landing Weight or Target Gradient");
  }
  if (hasLandingWeightInput && landingWeightTInput <= 0) {
    throw new Error("Landing weight must be > 0 t");
  }

  const oatC = clampToAxis(config.reference.oatAxisC, oatCInput);
  const elevationFt = clampToAxis(config.reference.altitudeAxisFt, elevationFtInput);
  const referenceGradientPct = lookupGoAroundReferenceGradient(config, oatC, elevationFt);
  const speedAdjustmentPct = lookupGoAroundSpeedAdjustment(config, speedLabel, referenceGradientPct);
  const antiIceAdjustmentPct = lookupGoAroundAntiIceAdjustment(config, antiIceMode, oatC);
  const antiIceBand = getGoAroundAntiIceBand(oatC);
  const icingPenaltyPct = applyIcingPenalty ? -config.icingPenaltyPct : 0;
  const baseGradientWithoutWeightPct = referenceGradientPct + speedAdjustmentPct + antiIceAdjustmentPct + icingPenaltyPct;
  const warnings = [];
  if (oatC !== oatCInput) {
    warnings.push(`OAT clamped to ${format(oatC, 1)}°C`);
  }
  if (elevationFt !== elevationFtInput) {
    warnings.push(`Airport elevation clamped to ${format(elevationFt, 0)} ft`);
  }

  let landingWeightT;
  let weightAdjustmentPct;
  let mode;

  if (hasTargetGradientInput) {
    const profile = buildGoAroundWeightAdjustmentProfile(config, referenceGradientPct);
    const solution = solveGoAroundWeightForTargetGradient({
      config,
      referenceGradientPct,
      baseGradientWithoutWeightPct,
      targetGradientPct: targetGradientPctInput,
    });
    landingWeightT = solution.landingWeightT;
    weightAdjustmentPct = solution.appliedWeightAdjustmentPct;
    mode = "target";
    const finalAtMinWeight =
      baseGradientWithoutWeightPct +
      linearClamped(
        profile.weightAxis,
        profile.adjustmentByWeightPct,
        config.weightAdjustment.weightAxisT[0],
      );
    const finalAtMaxWeight =
      baseGradientWithoutWeightPct +
      linearClamped(
        profile.weightAxis,
        profile.adjustmentByWeightPct,
        config.weightAdjustment.weightAxisT[config.weightAdjustment.weightAxisT.length - 1],
      );
    const minFinal = Math.min(finalAtMinWeight, finalAtMaxWeight);
    const maxFinal = Math.max(finalAtMinWeight, finalAtMaxWeight);
    if (targetGradientPctInput < minFinal || targetGradientPctInput > maxFinal) {
      warnings.push(
        `Target gradient out of achievable range (${format(minFinal, 1)}% to ${format(maxFinal, 1)}%); required weight clamped`,
      );
    }
  } else {
    landingWeightT = clampToAxis(config.weightAdjustment.weightAxisT, landingWeightTInput);
    weightAdjustmentPct = lookupGoAroundWeightAdjustment(config, landingWeightT, referenceGradientPct);
    mode = "weight";
    if (landingWeightT !== landingWeightTInput) {
      warnings.push(`Landing weight clamped to ${format(landingWeightT, 1)} t`);
    }
  }

  const finalGradientPct =
    baseGradientWithoutWeightPct + weightAdjustmentPct;

  return {
    mode,
    flapLabel: config.flap,
    ranges,
    inputsUsed: {
      oatC,
      elevationFt,
      landingWeightT,
      speedLabel,
    },
    targetGradientPct: hasTargetGradientInput ? targetGradientPctInput : NaN,
    referenceGradientPct,
    weightAdjustmentPct,
    speedAdjustmentPct,
    antiIceAdjustmentPct,
    antiIceBand,
    icingPenaltyPct,
    finalGradientPct,
    warnings,
  };
}

function buildFuelRequirement({ flightFuelKg, landingWeightT, additionalHoldingMin, perfAdjust }) {
  if (!Number.isFinite(flightFuelKg) || flightFuelKg < 0) {
    throw new Error("Flight fuel is invalid");
  }
  if (!Number.isFinite(landingWeightT) || landingWeightT <= 0) {
    throw new Error("Landing weight is invalid");
  }
  if (!Number.isFinite(additionalHoldingMin)) {
    throw new Error("Additional holding minutes are invalid");
  }
  if (additionalHoldingMin < 0) {
    throw new Error("Additional holding minutes must be >= 0");
  }

  let frfFfEng;
  let additionalHoldFfEng;
  try {
    frfFfEng = lookupHoldMetric(landingWeightT, FRF_HOLD_ALTITUDE_FT, "ffEng") * (1 + perfAdjust);
  } catch (error) {
    throw new Error(`Unable to derive FRF from holding table: ${error.message}`);
  }
  try {
    additionalHoldFfEng = lookupHoldMetric(landingWeightT, ADDITIONAL_HOLD_ALTITUDE_FT, "ffEng") * (1 + perfAdjust);
  } catch (error) {
    throw new Error(`Unable to derive Additional Holding Fuel from holding table: ${error.message}`);
  }
  const frfFuelHrKg = frfFfEng * 2;
  const additionalHoldFuelHrKg = additionalHoldFfEng * 2;
  const frfKg = frfFuelHrKg * 0.5;
  const extraHoldingKg = additionalHoldFuelHrKg * (additionalHoldingMin / 60);
  const contingencyKg = clamp(flightFuelKg * 0.05, MIN_CONTINGENCY_KG, MAX_CONTINGENCY_KG);
  const totalFuelKg = flightFuelKg + frfKg + contingencyKg + extraHoldingKg + FIXED_ALLOWANCE_KG;

  return {
    frfKg,
    contingencyKg,
    extraHoldingKg,
    fixedAllowanceKg: FIXED_ALLOWANCE_KG,
    totalFuelKg,
  };
}

function shortTripCore(anm, weight, perfAdjust) {
  if (anm < 50 || anm > 600 || weight < 120 || weight > 200) {
    throw new Error("Short Trip fuel/alt input out of range (ANM 50-600, weight 120-200)");
  }

  const fuelByAnm = interpolateAcrossWeight(shortTripFuelAlt.weightAxis, shortTripFuelAlt.fuelValues, weight);
  const altByAnm = interpolateAcrossWeight(shortTripFuelAlt.weightAxis, shortTripFuelAlt.altitudeValues, weight);

  const fuel1000kg = linear(shortTripFuelAlt.anmAxis, fuelByAnm, anm);
  const altitudeFt = linear(shortTripFuelAlt.anmAxis, altByAnm, anm);
  const timeMinutes = linear(shortTripFuelAlt.anmAxis, shortTripFuelAlt.timeValuesText.map(timeTextToMinutes), anm);
  const flightFuelKg = fuel1000kg * 1000 * (1 + perfAdjust);

  return { flightFuelKg, altitudeFt, timeMinutes };
}

function shortTripFuelAndAlt(anm, weight, perfAdjust, additionalHoldingMin) {
  const core = shortTripCore(anm, weight, perfAdjust);
  const fuelBuildUp = buildFuelRequirement({
    flightFuelKg: core.flightFuelKg,
    landingWeightT: weight,
    additionalHoldingMin,
    perfAdjust,
  });

  return {
    flightFuelKg: core.flightFuelKg,
    frfKg: fuelBuildUp.frfKg,
    contingencyKg: fuelBuildUp.contingencyKg,
    extraHoldingKg: fuelBuildUp.extraHoldingKg,
    fixedAllowanceKg: fuelBuildUp.fixedAllowanceKg,
    totalFuelKg: fuelBuildUp.totalFuelKg,
    altitude: core.altitudeFt,
    timeMinutes: core.timeMinutes,
  };
}

function longRangeAnmFromGnm(gnm, wind) {
  return bilinear(longRangeAnm.gnmAxis, longRangeAnm.windAxis, longRangeAnm.values, gnm, wind);
}

function longRangeCore(anm, weight, perfAdjust) {
  if (anm < 800 || anm > 8400 || weight < 120 || weight > 200) {
    throw new Error("Long Range input out of range (ANM 800-8400, weight 120-200)");
  }

  const fuel1000kg = bilinear(
    longRangeFuelTable.anmAxis,
    longRangeFuelTable.weightAxis,
    longRangeFuelTable.fuelValues,
    anm,
    weight,
  );
  const timeDays = linear(longRangeFuelTable.anmAxis, longRangeFuelTable.timeValuesDays, anm);
  const timeMinutes = timeDays * 24 * 60;

  const flightFuel1000KgAdjusted = fuel1000kg * (1 + perfAdjust);
  return {
    flightFuel1000Kg: flightFuel1000KgAdjusted,
    flightFuelKg: flightFuel1000KgAdjusted * 1000,
    timeMinutes,
  };
}

function longRangeFuel(anm, weight, perfAdjust, additionalHoldingMin) {
  const core = longRangeCore(anm, weight, perfAdjust);
  const fuelBuildUp = buildFuelRequirement({
    flightFuelKg: core.flightFuelKg,
    landingWeightT: weight,
    additionalHoldingMin,
    perfAdjust,
  });

  return {
    flightFuel1000Kg: core.flightFuel1000Kg,
    frfKg: fuelBuildUp.frfKg,
    contingencyKg: fuelBuildUp.contingencyKg,
    extraHoldingKg: fuelBuildUp.extraHoldingKg,
    fixedAllowanceKg: fuelBuildUp.fixedAllowanceKg,
    totalFuelKg: fuelBuildUp.totalFuelKg,
    timeMinutes: core.timeMinutes,
  };
}

function estimateLongSectorCruiseGuidance(landingWeightT, flightFuelKg, tripTimeMinutes) {
  if (!LRC_ALTITUDE_LIMITS_TABLE) return null;
  const ISA_DEVIATION_C = 10;
  const weightAxis = LRC_ALTITUDE_LIMITS_TABLE.weightAxisT || [];
  if (weightAxis.length < 2) return null;

  const minWeightT = weightAxis[0];
  const maxWeightT = weightAxis[weightAxis.length - 1];
  const startWeightEstimatedT = landingWeightT + flightFuelKg / 1000;
  const startWeightUsedT = clamp(startWeightEstimatedT, minWeightT, maxWeightT);
  const landingWeightUsedT = clamp(landingWeightT, minWeightT, maxWeightT);
  const startLimits = evaluateLrcAltitudeLimits(startWeightUsedT, ISA_DEVIATION_C);
  const landingLimits = evaluateLrcAltitudeLimits(landingWeightUsedT, ISA_DEVIATION_C);
  const startBandLowFt = Math.max(0, startLimits.optimumAltFt - 2000);
  const startBandHighFt = startLimits.optimumAltFt + 2000;

  const burnRateKgPerMin = tripTimeMinutes > 0 ? flightFuelKg / tripTimeMinutes : NaN;
  const stepClimbs = [];
  const nextStepFromFt = Math.floor(startLimits.optimumAltFt / 1000) * 1000 + 1000;
  const finalStepFt = Math.floor(landingLimits.optimumAltFt / 1000) * 1000;
  for (let altitudeFt = nextStepFromFt; altitudeFt <= finalStepFt; altitudeFt += 1000) {
    const triggerWeightT = weightForNominatedOptimumAltitude(altitudeFt, ISA_DEVIATION_C);
    if (triggerWeightT > startWeightUsedT + 1e-9 || triggerWeightT < landingWeightUsedT - 1e-9) continue;
    const burnToTriggerKg = Math.max(0, (startWeightEstimatedT - triggerWeightT) * 1000);
    const etaMin = Number.isFinite(burnRateKgPerMin) && burnRateKgPerMin > 0 ? burnToTriggerKg / burnRateKgPerMin : NaN;
    stepClimbs.push({
      altitudeFt,
      triggerWeightT,
      etaMin,
    });
  }

  return {
    isaDeviationC: ISA_DEVIATION_C,
    startWeightEstimatedT,
    startWeightUsedT,
    landingWeightUsedT,
    startOptimumAltFt: startLimits.optimumAltFt,
    landingOptimumAltFt: landingLimits.optimumAltFt,
    startBandLowFt,
    startBandHighFt,
    stepClimbs,
    clampedWeights:
      Math.abs(startWeightEstimatedT - startWeightUsedT) > 1e-9 || Math.abs(landingWeightT - landingWeightUsedT) > 1e-9,
  };
}

function calculateTripFuel(gnm, wind, weight, perfAdjust, additionalHoldingMin) {
  const shortAnm = (() => {
    try {
      return shortTripAnmFromGnm(gnm, wind);
    } catch {
      return NaN;
    }
  })();
  const longAnm = (() => {
    try {
      return longRangeAnmFromGnm(gnm, wind);
    } catch {
      return NaN;
    }
  })();
  if (!Number.isFinite(shortAnm) && !Number.isFinite(longAnm)) {
    throw new Error("Trip fuel ANM lookup out of range");
  }

  const referenceAnm = Number.isFinite(longAnm) ? longAnm : shortAnm;
  let mode;
  let anmDisplay;
  let flightFuelKg;
  let timeMinutes;
  let suggestedAltFt = NaN;
  let blendAlpha = NaN;

  if (referenceAnm < 600) {
    if (!Number.isFinite(shortAnm)) {
      throw new Error("Trip fuel requires short-trip coverage below 600 ANM");
    }
    const shortResult = shortTripCore(shortAnm, weight, perfAdjust);
    mode = "short";
    anmDisplay = shortAnm;
    flightFuelKg = shortResult.flightFuelKg;
    timeMinutes = shortResult.timeMinutes;
    suggestedAltFt = shortResult.altitudeFt;
  } else if (referenceAnm > 800) {
    if (!Number.isFinite(longAnm)) {
      throw new Error("Trip fuel requires long-range coverage above 800 ANM");
    }
    const longResult = longRangeCore(longAnm, weight, perfAdjust);
    mode = "long";
    anmDisplay = longAnm;
    flightFuelKg = longResult.flightFuelKg;
    timeMinutes = longResult.timeMinutes;
  } else {
    blendAlpha = clamp((referenceAnm - 600) / 200, 0, 1);
    const shortEdge = shortTripCore(600, weight, perfAdjust);
    const longEdge = longRangeCore(800, weight, perfAdjust);
    mode = "blend";
    anmDisplay =
      Number.isFinite(shortAnm) && Number.isFinite(longAnm)
        ? shortAnm + (longAnm - shortAnm) * blendAlpha
        : referenceAnm;
    flightFuelKg = shortEdge.flightFuelKg + (longEdge.flightFuelKg - shortEdge.flightFuelKg) * blendAlpha;
    timeMinutes = shortEdge.timeMinutes + (longEdge.timeMinutes - shortEdge.timeMinutes) * blendAlpha;
    suggestedAltFt = shortEdge.altitudeFt;
  }

  const fuelBuildUp = buildFuelRequirement({
    flightFuelKg,
    landingWeightT: weight,
    additionalHoldingMin,
    perfAdjust,
  });
  const longGuidance = anmDisplay >= 800 ? estimateLongSectorCruiseGuidance(weight, flightFuelKg, timeMinutes) : null;

  return {
    mode,
    anmDisplay,
    shortAnm,
    longAnm,
    blendAlpha,
    flightFuelKg,
    frfKg: fuelBuildUp.frfKg,
    contingencyKg: fuelBuildUp.contingencyKg,
    extraHoldingKg: fuelBuildUp.extraHoldingKg,
    fixedAllowanceKg: fuelBuildUp.fixedAllowanceKg,
    totalFuelKg: fuelBuildUp.totalFuelKg,
    timeMinutes,
    suggestedAltFt,
    longGuidance,
  };
}

function diversionLrcFuel(gnm, wind, altitudeFt, weightT, perfAdjust, additionalHoldingMin) {
  if (!DIVERSION_LRC_TABLE) {
    throw new Error("Diversion LRC table is missing");
  }
  if (!Number.isFinite(gnm) || !Number.isFinite(wind) || !Number.isFinite(altitudeFt) || !Number.isFinite(weightT)) {
    throw new Error("Diversion input is invalid");
  }
  if (!Number.isFinite(perfAdjust)) {
    throw new Error("Global flight plan performance adjustment is invalid");
  }

  const hasBands = DIVERSION_LRC_TABLE.low && DIVERSION_LRC_TABLE.high;
  const baseBand = hasBands ? DIVERSION_LRC_TABLE.low : DIVERSION_LRC_TABLE;
  const gnmAxis = baseBand.groundToAir.gnmAxis;
  const windAxis = baseBand.groundToAir.windAxis;
  const gnmUsed = clampToAxis(gnmAxis, gnm);
  const windUsed = clampToAxis(windAxis, wind);
  const weightAxis = baseBand.fuelAdjustment.weightAxisT;
  const weightUsed = clampToAxis(weightAxis, weightT);
  const altitudeMinFt = hasBands
    ? Math.min(
        DIVERSION_LRC_TABLE.low.fuelTime.altitudeAxisFt[0],
        DIVERSION_LRC_TABLE.high.fuelTime.altitudeAxisFt[0],
      )
    : baseBand.fuelTime.altitudeAxisFt[0];
  const altitudeMaxFt = hasBands
    ? Math.max(
        DIVERSION_LRC_TABLE.low.fuelTime.altitudeAxisFt[DIVERSION_LRC_TABLE.low.fuelTime.altitudeAxisFt.length - 1],
        DIVERSION_LRC_TABLE.high.fuelTime.altitudeAxisFt[DIVERSION_LRC_TABLE.high.fuelTime.altitudeAxisFt.length - 1],
      )
    : baseBand.fuelTime.altitudeAxisFt[baseBand.fuelTime.altitudeAxisFt.length - 1];
  const altitudeUsed = clamp(altitudeFt, altitudeMinFt, altitudeMaxFt);
  const warnings = [];
  if (gnmUsed !== gnm) warnings.push(`Ground distance clamped to ${format(gnmUsed, 0)} NM`);
  if (windUsed !== wind) warnings.push(`Wind clamped to ${format(windUsed, 0)} kt`);
  if (altitudeUsed !== altitudeFt) warnings.push(`Altitude clamped to ${format(altitudeUsed, 0)} ft`);
  if (weightUsed !== weightT) warnings.push(`Start weight clamped to ${format(weightUsed, 1)} t`);

  const evaluateBand = (tableSet) => {
    const anm = Math.abs(windUsed) < 1e-9
      ? gnmUsed
      : bilinearClamped(
          tableSet.groundToAir.gnmAxis,
          tableSet.groundToAir.windAxis,
          tableSet.groundToAir.values,
          gnmUsed,
          windUsed,
        );

    const referenceFuel1000Kg = bilinearClamped(
      tableSet.fuelTime.anmAxis,
      tableSet.fuelTime.altitudeAxisFt,
      tableSet.fuelTime.fuel1000KgValues,
      anm,
      altitudeUsed,
    );
    const timeMinutes = bilinearClamped(
      tableSet.fuelTime.anmAxis,
      tableSet.fuelTime.altitudeAxisFt,
      tableSet.fuelTime.timeMinutesValues,
      anm,
      altitudeUsed,
    );
    const adjustment1000Kg = bilinearClamped(
      tableSet.fuelAdjustment.referenceFuelAxis1000Kg,
      tableSet.fuelAdjustment.weightAxisT,
      tableSet.fuelAdjustment.adjustment1000KgValues,
      referenceFuel1000Kg,
      weightUsed,
    );

    return {
      anm,
      referenceFuel1000Kg,
      timeMinutes,
      adjustment1000Kg,
    };
  };

  let anm;
  let referenceFuel1000Kg;
  let timeMinutes;
  let adjustment1000Kg;

  if (!hasBands) {
    ({ anm, referenceFuel1000Kg, timeMinutes, adjustment1000Kg } = evaluateBand(DIVERSION_LRC_TABLE));
  } else {
    const lowBand = DIVERSION_LRC_TABLE.low;
    const highBand = DIVERSION_LRC_TABLE.high;
    const lowTopFt = lowBand.fuelTime.altitudeAxisFt[lowBand.fuelTime.altitudeAxisFt.length - 1];
    const highBottomFt = highBand.fuelTime.altitudeAxisFt[0];

    if (altitudeFt <= lowTopFt) {
      ({ anm, referenceFuel1000Kg, timeMinutes, adjustment1000Kg } = evaluateBand(lowBand));
    } else if (altitudeFt >= highBottomFt) {
      ({ anm, referenceFuel1000Kg, timeMinutes, adjustment1000Kg } = evaluateBand(highBand));
    } else {
      const lowEval = evaluateBand(lowBand);
      const highEval = evaluateBand(highBand);
      const alpha = (altitudeFt - lowTopFt) / (highBottomFt - lowTopFt);
      anm = lowEval.anm + (highEval.anm - lowEval.anm) * alpha;
      referenceFuel1000Kg = lowEval.referenceFuel1000Kg + (highEval.referenceFuel1000Kg - lowEval.referenceFuel1000Kg) * alpha;
      timeMinutes = lowEval.timeMinutes + (highEval.timeMinutes - lowEval.timeMinutes) * alpha;
      adjustment1000Kg = lowEval.adjustment1000Kg + (highEval.adjustment1000Kg - lowEval.adjustment1000Kg) * alpha;
    }
  }

  const adjustedFuelBeforePerf1000Kg = referenceFuel1000Kg + adjustment1000Kg;
  const adjustedFuel1000Kg = adjustedFuelBeforePerf1000Kg * (1 + perfAdjust);
  const adjustedFuelKg = adjustedFuel1000Kg * 1000;
  const reserveCalcWeightT = weightUsed - adjustedFuelKg / 1000 - FIXED_ALLOWANCE_KG / 1000;
  if (!Number.isFinite(reserveCalcWeightT) || reserveCalcWeightT <= 0) {
    throw new Error("Computed reserve-calculation weight is invalid (check start weight/fuel)");
  }
  const fuelBuildUp = buildFuelRequirement({
    flightFuelKg: adjustedFuelKg,
    landingWeightT: reserveCalcWeightT,
    additionalHoldingMin,
    perfAdjust,
  });

  return {
    anm,
    referenceFuel1000Kg,
    adjustment1000Kg,
    adjustedFuelBeforePerf1000Kg,
    adjustedFuel1000Kg,
    adjustedFuelKg,
    reserveCalcWeightT,
    frfKg: fuelBuildUp.frfKg,
    contingencyKg: fuelBuildUp.contingencyKg,
    extraHoldingKg: fuelBuildUp.extraHoldingKg,
    fixedAllowanceKg: fuelBuildUp.fixedAllowanceKg,
    totalFuelKg: fuelBuildUp.totalFuelKg,
    timeMinutes,
    warnings,
    usedInputs: {
      gnm: gnmUsed,
      wind: windUsed,
      altitudeFt: altitudeUsed,
      weightT: weightUsed,
    },
  };
}

function getHoldingStateFromFlapsUpTable(weightT, altitudeFt) {
  if (!FLAPS_UP_TABLE || !Array.isArray(FLAPS_UP_TABLE.records)) {
    throw new Error("Flaps-up holding table is missing");
  }

  const altitudeAxis = FLAPS_UP_TABLE.altitudesFt;
  const tryInterp = (values, label) => {
    try {
      return interpolateFromAvailablePoints(altitudeAxis, values, altitudeFt, label);
    } catch {
      return NaN;
    }
  };

  const metricsByWeight = FLAPS_UP_TABLE.records.map((record) => ({
    weight: record.weightT,
    kias: tryInterp(record.kiasByAlt, `Hold IAS at ${record.weightT}t`),
    ffEng: tryInterp(record.ffEngByAlt, `Hold FF/ENG at ${record.weightT}t`),
  }));

  const kias = interpolateAcrossWeightPoints(
    metricsByWeight.map((m) => ({ weight: m.weight, value: m.kias })),
    weightT,
    "Hold IAS",
  );
  const ffEng = interpolateAcrossWeightPoints(
    metricsByWeight.map((m) => ({ weight: m.weight, value: m.ffEng })),
    weightT,
    "Hold FF/ENG",
  );

  const atmosphere = atmosphereFromPressureAltitude({
    pressureAltitudeFt: altitudeFt,
    tempMode: "isa-dev",
    isaDeviationC: 0,
    oatC: 0,
  });
  const speed = iasToMachTas({
    iasKt: kias,
    pressurePa: atmosphere.pressurePa,
    speedOfSoundMps: atmosphere.speedOfSoundMps,
  });

  return {
    kias,
    tas: speed.tasKt,
    mach: speed.mach,
    ffEng,
  };
}

function lookupHoldMetric(weight, altitude, key) {
  const state = getHoldingStateFromFlapsUpTable(weight, altitude);
  if (!(key in state)) {
    throw new Error(`Unknown holding metric: ${key}`);
  }
  return state[key];
}

function holdingAt(weight, altitude, wind, perfAdjust) {
  const state = getHoldingStateFromFlapsUpTable(weight, altitude);
  const ffEng = state.ffEng * (1 + perfAdjust);
  const fuelHr = ffEng * 2;
  const gs = state.tas + wind;

  if (gs <= 0) {
    throw new Error("Ground speed <= 0 kt in holding calculation");
  }

  return {
    kias: state.kias,
    tas: state.tas,
    mach: state.mach,
    ffEng,
    fuelHr,
    gs,
    kgPerGnm: fuelHr / gs,
    lessFivePct: fuelHr * 0.95,
  };
}

function windVectorFromDirection(windFromDeg, windSpeedKt) {
  const windToDeg = normalize360(windFromDeg + 180);
  const windToRad = toRadians(windToDeg);
  return {
    eastKt: windSpeedKt * Math.sin(windToRad),
    northKt: windSpeedKt * Math.cos(windToRad),
  };
}

function solveHeadingForTrack(trackDeg, tasKt, windFromDeg, windSpeedKt) {
  const trackRad = toRadians(normalize360(trackDeg));
  const trackUnit = {
    east: Math.sin(trackRad),
    north: Math.cos(trackRad),
  };
  const rightUnit = {
    east: Math.cos(trackRad),
    north: -Math.sin(trackRad),
  };
  const windVec = windVectorFromDirection(windFromDeg, windSpeedKt);
  const windAlong = windVec.eastKt * trackUnit.east + windVec.northKt * trackUnit.north;
  const windCross = windVec.eastKt * rightUnit.east + windVec.northKt * rightUnit.north;

  const crossRatio = -windCross / tasKt;
  if (Math.abs(crossRatio) > 1) {
    throw new Error("Crosswind component exceeds TAS; cannot maintain selected inbound/outbound tracks");
  }

  const wcaRad = Math.asin(crossRatio);
  const headingDeg = normalize360(trackDeg + toDegrees(wcaRad));
  const gsKt = tasKt * Math.cos(wcaRad) + windAlong;
  if (gsKt <= 0) {
    throw new Error("Computed ground speed <= 0 kt");
  }

  return {
    headingDeg,
    gsKt,
    wcaDeg: toDegrees(wcaRad),
    windAlongKt: windAlong,
    windCrossKt: windCross,
  };
}

function computeReferenceTurnRadiusNm(tasKt, windSpeedKt, bankLimitDeg = DEFAULT_HOLD_BANK_DEG) {
  if (!Number.isFinite(tasKt) || tasKt <= 0) {
    throw new Error("TAS must be > 0 kt");
  }
  if (!Number.isFinite(windSpeedKt) || windSpeedKt < 0) {
    throw new Error("Wind speed must be >= 0 kt");
  }
  if (!Number.isFinite(bankLimitDeg) || bankLimitDeg <= 0 || bankLimitDeg >= 90) {
    throw new Error("Bank limit must be > 0 and < 90 deg");
  }
  const referenceGsKt = tasKt + Math.abs(windSpeedKt);
  if (referenceGsKt <= 0) {
    throw new Error("Reference ground speed is invalid");
  }
  const radiusM = (referenceGsKt * KT_TO_MPS) ** 2 / (G0 * Math.tan(toRadians(bankLimitDeg)));
  const radiusNm = radiusM / 1852;
  const referenceRateDegPerSec = toDegrees((referenceGsKt / 3600) / radiusNm);
  return {
    referenceGsKt,
    radiusNm,
    referenceRateDegPerSec,
    bankLimitDeg,
  };
}

function averageTurnGroundSpeed({
  startTrackDeg,
  holdSide,
  tasKt,
  windFromDeg,
  windSpeedKt,
  label,
  samples = 72,
}) {
  if (holdSide !== "R" && holdSide !== "L") {
    throw new Error("Hold side must be L or R");
  }
  const direction = holdSide === "R" ? 1 : -1;
  let gsSum = 0;

  for (let i = 0; i < samples; i += 1) {
    const t = (i + 0.5) / samples;
    const trackDeg = normalize360(startTrackDeg + direction * 180 * t);
    let state;
    try {
      state = solveHeadingForTrack(trackDeg, tasKt, windFromDeg, windSpeedKt);
    } catch (error) {
      throw new Error(`Unable to compute ${label} ground speed through turn: ${error.message}`);
    }
    gsSum += state.gsKt;
  }

  return gsSum / samples;
}

function calculateHoldTiming({
  mode,
  totalHoldMin,
  inboundLegMin,
  holdSide,
  inboundCourseDeg,
  windFromDeg,
  windSpeedKt,
  pressureAltitudeFt,
  iasKt,
  isaDeviationC,
  bankLimitDeg = DEFAULT_HOLD_BANK_DEG,
}) {
  if (!Number.isFinite(pressureAltitudeFt) || pressureAltitudeFt <= 0) {
    throw new Error("Timing altitude must be a positive value in feet");
  }
  if (!Number.isFinite(iasKt) || iasKt <= 0) {
    throw new Error("Timing IAS must be > 0 kt");
  }
  if (!Number.isFinite(windSpeedKt) || windSpeedKt < 0) {
    throw new Error("Wind speed must be >= 0 kt");
  }
  if (!Number.isFinite(inboundCourseDeg)) {
    throw new Error("Inbound course is invalid");
  }
  if (!Number.isFinite(windFromDeg)) {
    throw new Error("Wind direction is invalid");
  }
  if (!Number.isFinite(isaDeviationC)) {
    throw new Error("Timing ISA deviation is invalid");
  }
  if (!Number.isFinite(bankLimitDeg) || bankLimitDeg <= 0 || bankLimitDeg >= 90) {
    throw new Error("Bank limit must be > 0 and < 90 deg");
  }

  const atmosphere = atmosphereFromPressureAltitude({
    pressureAltitudeFt,
    tempMode: "isa-dev",
    isaDeviationC,
    oatC: 0,
  });
  const speed = iasToMachTas({
    iasKt,
    pressurePa: atmosphere.pressurePa,
    speedOfSoundMps: atmosphere.speedOfSoundMps,
  });

  const inboundTrack = normalize360(inboundCourseDeg);
  const outboundTrack = normalize360(inboundTrack + 180);
  const inbound = solveHeadingForTrack(inboundTrack, speed.tasKt, windFromDeg, windSpeedKt);
  const outbound = solveHeadingForTrack(outboundTrack, speed.tasKt, windFromDeg, windSpeedKt);

  const turnRef = computeReferenceTurnRadiusNm(speed.tasKt, windSpeedKt, bankLimitDeg);
  if (!Number.isFinite(turnRef.radiusNm) || turnRef.radiusNm <= 0) {
    throw new Error("Turn radius is invalid");
  }

  const turn1Deg = 180;
  const turn2Deg = 180;
  const turn1AvgGsKt = averageTurnGroundSpeed({
    startTrackDeg: inboundTrack,
    holdSide,
    tasKt: speed.tasKt,
    windFromDeg,
    windSpeedKt,
    label: "turn 1",
  });
  const turn2AvgGsKt = averageTurnGroundSpeed({
    startTrackDeg: outboundTrack,
    holdSide,
    tasKt: speed.tasKt,
    windFromDeg,
    windSpeedKt,
    label: "turn 2",
  });
  const turnRadiusNm = turnRef.radiusNm;

  const turn1RateDegPerSec = toDegrees((turn1AvgGsKt / 3600) / turnRadiusNm);
  const turn2RateDegPerSec = toDegrees((turn2AvgGsKt / 3600) / turnRadiusNm);
  const turn1BankDeg = toDegrees(Math.atan((toRadians(turn1RateDegPerSec) * speed.tasKt * KT_TO_MPS) / G0));
  const turn2BankDeg = toDegrees(Math.atan((toRadians(turn2RateDegPerSec) * speed.tasKt * KT_TO_MPS) / G0));
  const turn1Min = (turn1Deg / turn1RateDegPerSec) / 60;
  const turn2Min = (turn2Deg / turn2RateDegPerSec) / 60;
  const totalTurnMin = turn1Min + turn2Min;
  const gsRatioInToOut = inbound.gsKt / outbound.gsKt;

  let computedInboundMin;
  let computedTotalMin;
  let outboundLegMin;
  if (mode === "given-inbound") {
    if (!Number.isFinite(inboundLegMin) || inboundLegMin <= 0) {
      throw new Error("Inbound leg time must be > 0 min");
    }
    computedInboundMin = inboundLegMin;
    outboundLegMin = computedInboundMin * gsRatioInToOut;
    computedTotalMin = computedInboundMin + outboundLegMin + totalTurnMin;
  } else if (mode === "given-total") {
    if (!Number.isFinite(totalHoldMin) || totalHoldMin <= 0) {
      throw new Error("Total hold time must be > 0 min");
    }
    if (totalHoldMin <= totalTurnMin) {
      throw new Error("Total hold time is too short for turns at selected speed/bank");
    }
    computedTotalMin = totalHoldMin;
    computedInboundMin = (computedTotalMin - totalTurnMin) / (1 + gsRatioInToOut);
    outboundLegMin = computedInboundMin * gsRatioInToOut;
  } else {
    throw new Error("Unknown hold timing mode");
  }

  return {
    iasKt: speed.iasKt,
    tasKt: speed.tasKt,
    mach: speed.mach,
    inboundTrackDeg: inboundTrack,
    outboundTrackDeg: outboundTrack,
    inboundHeadingDeg: inbound.headingDeg,
    outboundHeadingDeg: outbound.headingDeg,
    inboundGroundSpeedKt: inbound.gsKt,
    outboundGroundSpeedKt: outbound.gsKt,
    inboundWcaDeg: inbound.wcaDeg,
    outboundWcaDeg: outbound.wcaDeg,
    turn1RateDegPerSec,
    turn2RateDegPerSec,
    referenceTurnRateDegPerSec: turnRef.referenceRateDegPerSec,
    referenceTurnGsKt: turnRef.referenceGsKt,
    turnRadiusNm,
    turn1AvgGsKt,
    turn2AvgGsKt,
    turn1BankDeg,
    turn2BankDeg,
    turnModel: `${format(bankLimitDeg, 1)}° bank radius reference`,
    turn1Deg,
    turn2Deg,
    turn1Min,
    turn2Min,
    totalTurnMin,
    gsRatioInToOut,
    inboundLegMin: computedInboundMin,
    outboundLegMin,
    totalHoldMin: computedTotalMin,
    inboundLegNm: (inbound.gsKt * computedInboundMin) / 60,
    outboundLegNm: (outbound.gsKt * outboundLegMin) / 60,
  };
}

function getLevelChangeRateFpm(levelChangeMode) {
  if (levelChangeMode === "climb") return LOSE_TIME_CLIMB_RATE_FPM;
  if (levelChangeMode === "descent") return LOSE_TIME_DESCENT_RATE_FPM;
  return 0;
}

function getLevelChangeDurationMin(startFl, levelChange) {
  if (levelChange.mode === "none") return 0;
  const deltaFt = Math.abs((levelChange.newFl - startFl) * 100);
  if (deltaFt === 0) return 0;
  const rateFpm = getLevelChangeRateFpm(levelChange.mode);
  if (rateFpm <= 0) {
    throw new Error("Level change rate is invalid");
  }
  return deltaFt / rateFpm;
}

function getFlightLevelAtElapsed(startFl, levelChange, elapsedMin) {
  if (levelChange.mode === "none") return startFl;

  const levelChangeStartMin = levelChange.afterMin;
  const levelChangeDurationMin = getLevelChangeDurationMin(startFl, levelChange);
  const levelChangeEndMin = levelChangeStartMin + levelChangeDurationMin;

  if (elapsedMin <= levelChangeStartMin) return startFl;
  if (elapsedMin >= levelChangeEndMin || levelChangeDurationMin <= 0) return levelChange.newFl;

  const t = (elapsedMin - levelChangeStartMin) / levelChangeDurationMin;
  return startFl + (levelChange.newFl - startFl) * t;
}

function validateLevelChange(levelChange, startFl) {
  if (levelChange.mode === "none") return;
  if (!Number.isFinite(levelChange.afterMin) || levelChange.afterMin < 0) {
    throw new Error("Level change time must be >= 0 minutes");
  }
  if (!Number.isFinite(levelChange.newFl) || levelChange.newFl <= 0) {
    throw new Error("New FL must be a positive number");
  }
  if (levelChange.mode === "climb" && levelChange.newFl <= startFl) {
    throw new Error("Climb requires new FL above current FL");
  }
  if (levelChange.mode === "descent" && levelChange.newFl >= startFl) {
    throw new Error("Descent requires new FL below current FL");
  }
}

function interpolateFromAvailablePoints(xAxis, yAxis, x, label) {
  const points = xAxis
    .map((xVal, idx) => ({ x: xVal, y: yAxis[idx] }))
    .filter((point) => Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);

  if (points.length < 2) {
    throw new Error(`Insufficient ${label} data for interpolation`);
  }

  const minX = points[0].x;
  const maxX = points[points.length - 1].x;
  if (x < minX || x > maxX) {
    throw new Error(`${label} out of range (${format(minX, 0)}-${format(maxX, 0)})`);
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (x >= p0.x && x <= p1.x) {
      if (p1.x === p0.x) return p0.y;
      const t = (x - p0.x) / (p1.x - p0.x);
      return p0.y + (p1.y - p0.y) * t;
    }
  }

  return points[points.length - 1].y;
}

function interpolateFromAvailablePointsClamped(xAxis, yAxis, x, label) {
  const points = xAxis
    .map((xVal, idx) => ({ x: xVal, y: yAxis[idx] }))
    .filter((point) => Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);

  if (points.length === 0) {
    throw new Error(`No ${label} data available`);
  }
  if (points.length === 1) {
    return points[0].y;
  }

  if (x <= points[0].x) return points[0].y;
  if (x >= points[points.length - 1].x) return points[points.length - 1].y;

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (x >= p0.x && x <= p1.x) {
      if (p1.x === p0.x) return p0.y;
      const t = (x - p0.x) / (p1.x - p0.x);
      return p0.y + (p1.y - p0.y) * t;
    }
  }

  return points[points.length - 1].y;
}

function interpolateAcrossWeightPoints(weightPoints, weight, label) {
  const points = weightPoints
    .filter((point) => Number.isFinite(point.value))
    .sort((a, b) => a.weight - b.weight);

  if (points.length < 2) {
    throw new Error(`Insufficient ${label} data across weights`);
  }

  const minWeight = points[0].weight;
  const maxWeight = points[points.length - 1].weight;
  if (weight < minWeight || weight > maxWeight) {
    throw new Error(`${label} weight out of range (${format(minWeight, 1)}-${format(maxWeight, 1)} t)`);
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (weight >= p0.weight && weight <= p1.weight) {
      if (p1.weight === p0.weight) return p0.value;
      const t = (weight - p0.weight) / (p1.weight - p0.weight);
      return p0.value + (p1.value - p0.value) * t;
    }
  }

  return points[points.length - 1].value;
}

function getLrcCruiseState(weightT, flightLevel, windKt, perfAdjust = 0) {
  if (!LRC_CRUISE_TABLE || !Array.isArray(LRC_CRUISE_TABLE.records)) {
    throw new Error("LRC cruise table is missing");
  }

  const cruiseTableFl = userFlToTableFl(flightLevel);
  const altitudeAxis = LRC_CRUISE_TABLE.altitudesFL;
  const minFl = altitudeAxis[0];
  const maxFl = altitudeAxis[altitudeAxis.length - 1];
  if (cruiseTableFl < minFl || cruiseTableFl > maxFl) {
    throw new Error(`LRC FL out of range (${format(minFl * 10, 0)}-${format(maxFl * 10, 0)})`);
  }
  const tryInterp = (values, label) => {
    try {
      return interpolateFromAvailablePoints(altitudeAxis, values, cruiseTableFl, label);
    } catch {
      return NaN;
    }
  };
  const metricsByWeight = LRC_CRUISE_TABLE.records.map((record) => ({
    weight: record.weightT,
    mach: tryInterp(record.machByAlt, `Mach at ${record.weightT}t`),
    ias: tryInterp(record.kiasByAlt, `IAS at ${record.weightT}t`),
    ffEng: tryInterp(record.ffEngByAlt, `FF/ENG at ${record.weightT}t`),
  }));

  let mach;
  try {
    mach = interpolateAcrossWeightPoints(
      metricsByWeight.map((m) => ({ weight: m.weight, value: m.mach })),
      weightT,
      "LRC Mach",
    );
  } catch (error) {
    if (String(error?.message || "").startsWith("Insufficient LRC Mach data across weights")) {
      throw new Error(`LRC Mach unavailable at FL${format(flightLevel, 0)} for interpolation across weights`);
    }
    throw error;
  }
  const ias = interpolateAcrossWeightPoints(
    metricsByWeight.map((m) => ({ weight: m.weight, value: m.ias })),
    weightT,
    "LRC IAS",
  );
  const ffEng = interpolateAcrossWeightPoints(
    metricsByWeight.map((m) => ({ weight: m.weight, value: m.ffEng })),
    weightT,
    "LRC FF/ENG",
  );

  const atmosphere = atmosphereFromPressureAltitude({
    pressureAltitudeFt: flightLevel * 100,
    tempMode: "isa-dev",
    isaDeviationC: 0,
    oatC: 0,
  });
  const tas = mach * atmosphere.speedOfSoundMps * MPS_TO_KT;
  const gs = tas + windKt;
  if (gs <= 0) {
    throw new Error("Cruise ground speed <= 0 kt");
  }

  return {
    ias,
    mach,
    tas,
    ffEng: ffEng * (1 + perfAdjust),
    fuelHr: ffEng * (1 + perfAdjust) * 2,
    gs,
  };
}

function getHoldState(weightT, flightLevel, windKt, perfAdjust = 0) {
  const hold = holdingAt(weightT, flightLevel * 100, windKt, 0);
  return {
    ias: hold.kias,
    mach: NaN,
    tas: hold.tas,
    ffEng: hold.ffEng * (1 + perfAdjust),
    fuelHr: hold.fuelHr * (1 + perfAdjust),
    gs: hold.gs,
  };
}

function simulateToFixAndOptionalHold({
  distanceNm,
  startWeightT,
  startFl,
  cruiseWindKt,
  holdWindKt,
  levelChange,
  switchToHoldSpeedAtMin,
  holdAtFixMin,
  perfAdjust,
  dtMin = 1,
}) {
  let elapsedMin = 0;
  let remainingNm = distanceNm;
  let weightT = startWeightT;
  let fuelBurnKg = 0;
  let timeToFixMin = null;
  let switchInfo = null;
  let holdRemainingMin = holdAtFixMin;
  let switched = false;
  const levelChangeDurationMin = getLevelChangeDurationMin(startFl, levelChange);
  const levelChangeStartMin = levelChange.mode === "none" ? Infinity : levelChange.afterMin;
  const levelChangeEndMin =
    levelChange.mode === "none" ? Infinity : levelChange.afterMin + levelChangeDurationMin;

  for (let guard = 0; guard < 20000; guard += 1) {
    if (remainingNm <= 1e-7 && holdRemainingMin <= 1e-7) break;

    const currentFl = getFlightLevelAtElapsed(startFl, levelChange, elapsedMin);
    const inTransit = remainingNm > 1e-7;
    const inHoldAtFix = !inTransit;

    let phase = "hold-at-fix";
    if (inTransit) {
      if (elapsedMin >= switchToHoldSpeedAtMin) {
        phase = "hold-speed-enroute";
        if (!switched) {
          switched = true;
          switchInfo = {
            atElapsedMin: elapsedMin,
            remainingNmAtSwitch: remainingNm,
          };
        }
      } else {
        phase = "lrc-cruise";
      }
    }

    let perf;
    if (phase === "lrc-cruise") {
      perf = getLrcCruiseState(weightT, currentFl, cruiseWindKt, perfAdjust);
    } else if (phase === "hold-speed-enroute") {
      perf = getHoldState(weightT, currentFl, holdWindKt, perfAdjust);
    } else {
      perf = getHoldState(weightT, currentFl, holdWindKt, perfAdjust);
    }

    let stepMin = dtMin;
    const nextLevelChangeStartDelta = elapsedMin < levelChangeStartMin ? levelChangeStartMin - elapsedMin : Infinity;
    const nextLevelChangeEndDelta = elapsedMin < levelChangeEndMin ? levelChangeEndMin - elapsedMin : Infinity;
    const nextSwitchDelta =
      inTransit && elapsedMin < switchToHoldSpeedAtMin ? switchToHoldSpeedAtMin - elapsedMin : Infinity;
    stepMin = Math.min(stepMin, nextLevelChangeStartDelta, nextLevelChangeEndDelta, nextSwitchDelta);

    if (phase === "lrc-cruise" || phase === "hold-speed-enroute") {
      const timeToFixCandidate = (remainingNm / perf.gs) * 60;
      stepMin = Math.min(stepMin, timeToFixCandidate);
    } else if (inHoldAtFix) {
      stepMin = Math.min(stepMin, holdRemainingMin);
    }

    if (!Number.isFinite(stepMin) || stepMin <= 0) {
      throw new Error("Simulation step collapsed to zero");
    }

    const effectiveFuelHr =
      phase === "hold-speed-enroute" ? perf.fuelHr * ENROUTE_HOLD_SPEED_FUEL_FACTOR : perf.fuelHr;
    const burnKg = effectiveFuelHr * (stepMin / 60);
    fuelBurnKg += burnKg;
    weightT -= burnKg / 1000;

    if (phase === "lrc-cruise" || phase === "hold-speed-enroute") {
      remainingNm = Math.max(0, remainingNm - perf.gs * (stepMin / 60));
      if (remainingNm <= 1e-7 && timeToFixMin === null) {
        timeToFixMin = elapsedMin + stepMin;
      }
    } else {
      holdRemainingMin = Math.max(0, holdRemainingMin - stepMin);
    }

    elapsedMin += stepMin;
    if (weightT <= 0) {
      throw new Error("Weight reduced below zero during simulation");
    }
  }

  if (timeToFixMin === null) {
    timeToFixMin = elapsedMin;
  }

  return {
    timeToFixMin,
    totalTimeMin: elapsedMin,
    fuelBurnKg,
    finalWeightT: weightT,
    switchInfo,
  };
}

function calculateRequiredSpeedToMeetFixTime({ distanceNm, targetFixTimeMin, startFl, windKt }) {
  if (!Number.isFinite(distanceNm) || distanceNm <= 0) {
    throw new Error("Distance to fix must be > 0 NM");
  }
  if (!Number.isFinite(targetFixTimeMin) || targetFixTimeMin <= 0) {
    throw new Error("Target fix time must be > 0 min");
  }
  if (!Number.isFinite(startFl) || startFl <= 0) {
    throw new Error("Start FL must be > 0");
  }
  if (!Number.isFinite(windKt)) {
    throw new Error("Wind is invalid");
  }

  const requiredGsKt = distanceNm / (targetFixTimeMin / 60);
  const requiredTasKt = requiredGsKt - windKt;
  if (requiredTasKt <= 0) {
    throw new Error("Required speed is not achievable with current wind");
  }

  const atmosphere = atmosphereFromPressureAltitude({
    pressureAltitudeFt: startFl * 100,
    tempMode: "isa-dev",
    isaDeviationC: 0,
    oatC: 0,
  });
  const converted = tasToIasMach({
    tasKt: requiredTasKt,
    pressurePa: atmosphere.pressurePa,
    speedOfSoundMps: atmosphere.speedOfSoundMps,
  });

  return {
    requiredGsKt,
    requiredTasKt,
    requiredIasKt: converted.iasKt,
    requiredMach: converted.mach,
  };
}

function buildLoseTimeComparison({
  distanceNm,
  startWeightT,
  startFl,
  requiredDelayMin,
  cruiseWindKt,
  holdWindKt,
  levelChange,
  perfAdjust,
}) {
  if (!Number.isFinite(distanceNm)) throw new Error("Distance to fix is invalid");
  if (!Number.isFinite(requiredDelayMin)) throw new Error("Required delay is invalid");
  if (!Number.isFinite(startWeightT)) throw new Error("Current weight is invalid");
  if (!Number.isFinite(startFl)) throw new Error("Current FL is invalid");
  if (!Number.isFinite(cruiseWindKt) || !Number.isFinite(holdWindKt)) throw new Error("Wind is invalid");
  if (!Number.isFinite(perfAdjust)) throw new Error("Performance adjustment is invalid");
  if (distanceNm <= 0) throw new Error("Distance to fix must be > 0 NM");
  if (requiredDelayMin < 0) throw new Error("Required delay must be >= 0 min");
  if (startWeightT <= 0) throw new Error("Current weight must be > 0");
  if (startFl <= 0) throw new Error("Current FL must be > 0");

  validateLevelChange(levelChange, startFl);

  const baseline = simulateToFixAndOptionalHold({
    distanceNm,
    startWeightT,
    startFl,
    cruiseWindKt,
    holdWindKt,
    levelChange,
    switchToHoldSpeedAtMin: Number.POSITIVE_INFINITY,
    holdAtFixMin: 0,
    perfAdjust,
  });

  const optionA = simulateToFixAndOptionalHold({
    distanceNm,
    startWeightT,
    startFl,
    cruiseWindKt,
    holdWindKt,
    levelChange,
    switchToHoldSpeedAtMin: Number.POSITIVE_INFINITY,
    holdAtFixMin: requiredDelayMin,
    perfAdjust,
  });

  const targetFixTime = baseline.timeToFixMin + requiredDelayMin;

  const allHoldTransit = simulateToFixAndOptionalHold({
    distanceNm,
    startWeightT,
    startFl,
    cruiseWindKt,
    holdWindKt,
    levelChange,
    switchToHoldSpeedAtMin: 0,
    holdAtFixMin: 0,
    perfAdjust,
  });

  let optionBTransit;
  let residualHoldMin = 0;

  if (targetFixTime > allHoldTransit.timeToFixMin) {
    optionBTransit = allHoldTransit;
    residualHoldMin = targetFixTime - allHoldTransit.timeToFixMin;
  } else {
    let low = 0;
    let high = Math.max(targetFixTime + 60, baseline.timeToFixMin + 60);
    let lowSim = allHoldTransit;
    let highSim = simulateToFixAndOptionalHold({
      distanceNm,
      startWeightT,
      startFl,
      cruiseWindKt,
      holdWindKt,
      levelChange,
      switchToHoldSpeedAtMin: high,
      holdAtFixMin: 0,
      perfAdjust,
    });

    if (lowSim.timeToFixMin < targetFixTime || highSim.timeToFixMin > targetFixTime) {
      throw new Error("Unable to bracket switch point for enroute delay solution");
    }

    for (let i = 0; i < 24; i += 1) {
      const mid = (low + high) / 2;
      const midSim = simulateToFixAndOptionalHold({
        distanceNm,
        startWeightT,
        startFl,
        cruiseWindKt,
        holdWindKt,
        levelChange,
        switchToHoldSpeedAtMin: mid,
        holdAtFixMin: 0,
        perfAdjust,
      });

      if (midSim.timeToFixMin > targetFixTime) {
        low = mid;
        lowSim = midSim;
      } else {
        high = mid;
        highSim = midSim;
      }
    }

    optionBTransit =
      Math.abs(lowSim.timeToFixMin - targetFixTime) <= Math.abs(highSim.timeToFixMin - targetFixTime) ? lowSim : highSim;
  }

  const optionB = simulateToFixAndOptionalHold({
    distanceNm,
    startWeightT,
    startFl,
    cruiseWindKt,
    holdWindKt,
    levelChange,
    switchToHoldSpeedAtMin: optionBTransit.switchInfo ? optionBTransit.switchInfo.atElapsedMin : Number.POSITIVE_INFINITY,
    holdAtFixMin: residualHoldMin,
    perfAdjust,
  });

  let optionC = null;
  let optionCError = "";
  try {
    optionC = calculateRequiredSpeedToMeetFixTime({
      distanceNm,
      targetFixTimeMin: targetFixTime,
      startFl,
      windKt: cruiseWindKt,
    });
  } catch (error) {
    optionCError = String(error?.message || "Unable to compute required speed");
  }

  return {
    baseline,
    optionA,
    optionB,
    optionC,
    optionCError,
    targetFixTime,
    requiredDelayMin,
    residualHoldMin,
  };
}

function buildIsaBases() {
  const bases = [
    {
      hBaseM: ISA_LAYER_BASES_M[0],
      tBaseK: T0,
      pBasePa: P0,
      lapseRate: ISA_LAYER_LAPSE_RATES[0],
    },
  ];

  for (let i = 1; i < ISA_LAYER_BASES_M.length; i += 1) {
    const prev = bases[i - 1];
    const hBaseM = ISA_LAYER_BASES_M[i];
    const deltaH = hBaseM - prev.hBaseM;
    const lapse = prev.lapseRate;

    let tBaseK;
    let pBasePa;
    if (Math.abs(lapse) < 1e-12) {
      tBaseK = prev.tBaseK;
      pBasePa = prev.pBasePa * Math.exp((-G0 * deltaH) / (R_AIR * prev.tBaseK));
    } else {
      tBaseK = prev.tBaseK + lapse * deltaH;
      pBasePa = prev.pBasePa * (tBaseK / prev.tBaseK) ** (-G0 / (R_AIR * lapse));
    }

    bases.push({
      hBaseM,
      tBaseK,
      pBasePa,
      lapseRate: ISA_LAYER_LAPSE_RATES[i],
    });
  }

  return bases;
}

function geometricToGeopotentialMeters(geometricMeters) {
  return (EARTH_RADIUS_M * geometricMeters) / (EARTH_RADIUS_M + geometricMeters);
}

function isaStateAtGeopotential(geopotentialM) {
  if (geopotentialM > ISA_LAYER_BASES_M[ISA_LAYER_BASES_M.length - 1]) {
    throw new Error("Altitude out of ISA model range (max 47,000 m geopotential)");
  }

  let layerIndex = 0;
  for (let i = 0; i < ISA_BASES.length - 1; i += 1) {
    if (geopotentialM >= ISA_BASES[i].hBaseM && geopotentialM < ISA_BASES[i + 1].hBaseM) {
      layerIndex = i;
      break;
    }
    if (geopotentialM >= ISA_BASES[i + 1].hBaseM) {
      layerIndex = i + 1;
    }
  }

  const base = ISA_BASES[layerIndex];
  const deltaH = geopotentialM - base.hBaseM;
  let isaTempK;
  let pressurePa;

  if (Math.abs(base.lapseRate) < 1e-12) {
    isaTempK = base.tBaseK;
    pressurePa = base.pBasePa * Math.exp((-G0 * deltaH) / (R_AIR * base.tBaseK));
  } else {
    isaTempK = base.tBaseK + base.lapseRate * deltaH;
    pressurePa = base.pBasePa * (isaTempK / base.tBaseK) ** (-G0 / (R_AIR * base.lapseRate));
  }

  return { isaTempK, pressurePa };
}

function atmosphereFromPressureAltitude({ pressureAltitudeFt, tempMode, oatC, isaDeviationC }) {
  if (!Number.isFinite(pressureAltitudeFt)) {
    throw new Error("Invalid pressure altitude");
  }

  const geometricM = pressureAltitudeFt * FT_TO_M;
  const geopotentialM = geometricToGeopotentialMeters(geometricM);
  const { isaTempK, pressurePa } = isaStateAtGeopotential(geopotentialM);

  let actualTempK;
  if (tempMode === "isa-dev") {
    actualTempK = isaTempK + isaDeviationC;
  } else {
    actualTempK = oatC + 273.15;
  }

  if (!Number.isFinite(actualTempK) || actualTempK <= 0) {
    throw new Error("Temperature input is invalid for atmospheric computation");
  }

  return {
    pressurePa,
    isaTempK,
    actualTempK,
    speedOfSoundMps: Math.sqrt(GAMMA * R_AIR * actualTempK),
    geopotentialM,
  };
}

function iasToMachTas({ iasKt, pressurePa, speedOfSoundMps }) {
  if (!Number.isFinite(iasKt) || iasKt < 0) throw new Error("IAS must be >= 0");

  const vCas = iasKt * KT_TO_MPS;
  const qc = P0 * ((1 + ((GAMMA - 1) / 2) * (vCas / A0) ** 2) ** (GAMMA / (GAMMA - 1)) - 1);
  const mach = Math.sqrt((2 / (GAMMA - 1)) * ((qc / pressurePa + 1) ** ((GAMMA - 1) / GAMMA) - 1));
  const tasKt = mach * speedOfSoundMps * MPS_TO_KT;

  return { iasKt, mach, tasKt };
}

function machToIasTas({ mach, pressurePa, speedOfSoundMps }) {
  if (!Number.isFinite(mach) || mach < 0) throw new Error("Mach must be >= 0");

  const tasKt = mach * speedOfSoundMps * MPS_TO_KT;
  const qc = pressurePa * ((1 + ((GAMMA - 1) / 2) * mach ** 2) ** (GAMMA / (GAMMA - 1)) - 1);
  const casMps = A0 * Math.sqrt((2 / (GAMMA - 1)) * ((qc / P0 + 1) ** ((GAMMA - 1) / GAMMA) - 1));

  return { iasKt: casMps * MPS_TO_KT, mach, tasKt };
}

function tasToIasMach({ tasKt, pressurePa, speedOfSoundMps }) {
  if (!Number.isFinite(tasKt) || tasKt < 0) throw new Error("TAS must be >= 0");

  const mach = (tasKt * KT_TO_MPS) / speedOfSoundMps;
  const qc = pressurePa * ((1 + ((GAMMA - 1) / 2) * mach ** 2) ** (GAMMA / (GAMMA - 1)) - 1);
  const casMps = A0 * Math.sqrt((2 / (GAMMA - 1)) * ((qc / P0 + 1) ** ((GAMMA - 1) / GAMMA) - 1));

  return { iasKt: casMps * MPS_TO_KT, mach, tasKt };
}

function timeTextToMinutes(t) {
  const [h, m] = String(t).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

function renderRows(target, rows) {
  target.innerHTML = rows
    .map(([k, v]) => {
      if (k === "__spacer__") {
        return '<div class="result-spacer"></div>';
      }
      if (k === "__section__") {
        return `<div class="result-section-title">${v}</div>`;
      }
      if (k === "__warning__") {
        return `<div class="result-warning">${v}</div>`;
      }
      return `<div class="result-row"><span class="result-key">${k}</span><span class="result-value">${v}</span></div>`;
    })
    .join("");
}

function renderError(target, message) {
  target.innerHTML = `<div class="error">${message}</div>`;
}

function renderValidation(target, message) {
  target.innerHTML = `<div class="validation">${message}</div>`;
}

function missingFieldsBanner(target, missingNames) {
  const names = missingNames.filter(Boolean);
  if (names.length === 0) return false;
  const plural = names.length > 1 ? "s" : "";
  renderValidation(target, `Missing required input${plural}: ${names.join(", ")}`);
  return true;
}

function fieldIsBlank(value) {
  return String(value ?? "").trim() === "";
}

function getPersistableFields() {
  return Array.from(document.querySelectorAll("input[id], select[id], textarea[id]"));
}

function captureInputState() {
  const snapshot = {};
  getPersistableFields().forEach((el) => {
    if (!el.id) return;
    const type = (el.type || "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      snapshot[el.id] = { checked: !!el.checked };
    } else {
      snapshot[el.id] = { value: el.value };
    }
  });
  return snapshot;
}

function persistInputState() {
  try {
    localStorage.setItem(INPUT_STATE_STORAGE_KEY, JSON.stringify(captureInputState()));
  } catch {
    // Ignore storage failures (quota/privacy mode) and continue app execution.
  }
}

function restorePersistedInputState() {
  try {
    const raw = localStorage.getItem(INPUT_STATE_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return;
    getPersistableFields().forEach((el) => {
      if (!el.id || !(el.id in saved)) return;
      const savedEntry = saved[el.id];
      const type = (el.type || "").toLowerCase();
      if ((type === "checkbox" || type === "radio") && typeof savedEntry?.checked === "boolean") {
        el.checked = savedEntry.checked;
        return;
      }
      if (typeof savedEntry?.value === "string") {
        el.value = savedEntry.value;
      }
    });
  } catch {
    // Ignore malformed persisted state and continue with markup defaults.
  }
}

function installInputStatePersistence() {
  const onFieldEvent = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.matches("input[id], select[id], textarea[id]")) return;
    persistInputState();
  };

  document.addEventListener("input", onFieldEvent, true);
  document.addEventListener("change", onFieldEvent, true);
  document.addEventListener(
    "submit",
    () => {
      setTimeout(persistInputState, 0);
    },
    true,
  );
}

function bindTripFuel() {
  const form = document.querySelector("#trip-fuel-form");
  const out = document.querySelector("#trip-fuel-out");
  if (!form || !out) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (
      missingFieldsBanner(out, [
        fieldIsBlank(document.querySelector("#trip-gnm").value) ? "Ground Distance (GNM)" : "",
        fieldIsBlank(document.querySelector("#trip-wind").value) ? "Wind +/-" : "",
        fieldIsBlank(document.querySelector("#trip-weight").value) ? "Landing Weight" : "",
        fieldIsBlank(document.querySelector("#trip-hold-min").value) ? "Additional Holding Fuel (min)" : "",
      ])
    ) {
      return;
    }
    try {
      const gnm = parseNum(document.querySelector("#trip-gnm").value);
      const wind = parseNum(document.querySelector("#trip-wind").value);
      const weight = parseNum(document.querySelector("#trip-weight").value);
      const perfAdjust = getGlobalPerfAdjust();
      const holdingMin = parseNum(document.querySelector("#trip-hold-min").value);
      const result = calculateTripFuel(gnm, wind, weight, perfAdjust, holdingMin);

      const rows = [
        ["Air Distance (ANM)", `${format(result.anmDisplay, 0)} nm`],
        ["Flight Fuel", `${format(result.flightFuelKg, 0)} kg`],
        ["FRF (30 min hold @ 1500 ft)", `${format(result.frfKg, 0)} kg`],
        ["Contingency Fuel (5%, min 350, max 1200)", `${format(result.contingencyKg, 0)} kg`],
        [`Additional Holding Fuel (${format(holdingMin, 1)} min)`, `${format(result.extraHoldingKg, 0)} kg`],
        ["Approach Fuel", `${format(result.fixedAllowanceKg, 0)} kg`],
        ["Total Fuel Required", `${format(result.totalFuelKg, 0)} kg`],
        ["Time", formatMinutes(result.timeMinutes)],
      ];

      if (result.anmDisplay < 800 && Number.isFinite(result.suggestedAltFt)) {
        rows.splice(7, 0, ["Suggested Alt", `${format(result.suggestedAltFt, 0)} ft`]);
      }

      if (result.longGuidance) {
        const guidance = result.longGuidance;
        const climbPlanText = guidance.stepClimbs.length
          ? guidance.stepClimbs
              .map((step) => {
                const etaText = Number.isFinite(step.etaMin) ? ` (${formatMinutes(step.etaMin)})` : "";
                return `FL${format(step.altitudeFt / 100, 0)} @ ${format(step.triggerWeightT, 1)} t${etaText}`;
              })
              .join(" -> ")
          : "No step climb trigger within trip burn";

        rows.push(
          ["__spacer__", ""],
          ["__section__", "Estimated Long-Sector Altitude (ISA+10)"],
          ["Estimated Start Weight (Landing + Flight Fuel)", `${format(guidance.startWeightEstimatedT, 1)} t`],
          [
            "Estimated Optimum Altitude (Start / Landing)",
            `${format(guidance.startOptimumAltFt, 0)} / ${format(guidance.landingOptimumAltFt, 0)} ft (FL${format(guidance.startOptimumAltFt / 100, 0)} / FL${format(guidance.landingOptimumAltFt / 100, 0)})`,
          ],
          [
            "Recommended Cruise Band (Start Optimum \u00b12000)",
            `${format(guidance.startBandLowFt, 0)}-${format(guidance.startBandHighFt, 0)} ft`,
          ],
          ["Estimated Step Climb Triggers", climbPlanText],
        );

        if (guidance.clampedWeights) {
          rows.push([
            "__warning__",
            "Altitude estimate uses clamped weight at LRC altitude-table limits",
          ]);
        }
      }

      renderRows(out, rows);
    } catch (error) {
      renderError(out, error.message);
    }
  });

  form.dispatchEvent(new Event("submit"));
}

function bindLrcAltitudeLimits() {
  const form = document.querySelector("#lrc-altitude-form");
  const out = document.querySelector("#lrc-altitude-out");
  if (!form || !out) return;

  const isaDevEl = document.querySelector("#lrc-alt-isa-dev");
  const tempEl = document.querySelector("#lrc-alt-temp");
  const currentAltEl = document.querySelector("#lrc-alt-current");
  const targetAltEl = document.querySelector("#lrc-alt-target");
  let lastTempSource = "isa-dev";
  isaDevEl.addEventListener("input", () => {
    lastTempSource = "isa-dev";
  });
  tempEl.addEventListener("input", () => {
    lastTempSource = "temp";
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const targetAltRaw = String(targetAltEl.value ?? "").trim();
    const hasTargetOptimum = targetAltRaw !== "";
    if (
      missingFieldsBanner(out, [
        fieldIsBlank(document.querySelector("#lrc-alt-weight").value) ? "Weight" : "",
        hasTargetOptimum && fieldIsBlank(currentAltEl.value) ? "Current Alt/FL" : "",
      ])
    ) {
      return;
    }
    if (fieldIsBlank(isaDevEl.value) && fieldIsBlank(tempEl.value)) {
      renderValidation(out, "Missing required input: ISA Deviation or Temperature");
      return;
    }
    try {
      const weightT = parseNum(document.querySelector("#lrc-alt-weight").value);
      const currentAltRaw = String(currentAltEl.value ?? "").trim();
      const hasCurrentAlt = currentAltRaw !== "";
      const currentAltInput = hasCurrentAlt ? parseAltOrFlInput(currentAltRaw, "Current Alt/FL") : null;
      const targetAltInput = hasTargetOptimum
        ? parseAltOrFlInput(targetAltRaw, "New Optimum Altitude")
        : null;
      const currentFl = currentAltInput ? currentAltInput.flightLevel : 400;
      const currentAltitudeFt = currentAltInput ? currentAltInput.altitudeFt : 40000;
      const targetOptimumAltFt = targetAltInput ? targetAltInput.altitudeFt : NaN;
      const perfAdjust = getGlobalPerfAdjust();
      const temperaturePair = resolveTemperaturePair({
        isaDeviationRaw: isaDevEl.value,
        temperatureRaw: tempEl.value,
        lastSource: lastTempSource,
        pressureAltitudeFt: currentAltitudeFt,
        label: "LRC Altitude Limits temperature",
      });
      const isaDeviationCInput = temperaturePair.isaDeviationC;

      const limits = evaluateLrcAltitudeLimits(weightT, isaDeviationCInput);
      const driftdownRanges = getDriftdownRanges();
      const eoWeightUsedT = clamp(weightT, driftdownRanges.minWeightT, driftdownRanges.maxWeightT);
      const seLrcCapability = singleEngineLrcCapabilityAltitude(eoWeightUsedT, isaDeviationCInput);
      const driftLevelOff = evaluateDriftdownLevelOff(eoWeightUsedT, isaDeviationCInput);
      const eoWarnings = [];
      if (eoWeightUsedT !== weightT) {
        eoWarnings.push(`Engine inop weight clamped to ${format(eoWeightUsedT, 1)} t`);
      }

      if (currentAltInput && !currentAltInput.isThreeDigitFl) {
        currentAltEl.value = formatInputNumber(currentFl, 0);
      }
      if (targetAltInput && targetAltInput.isThreeDigitFl) {
        targetAltEl.value = formatInputNumber(targetOptimumAltFt, 0);
      }
      isaDevEl.value = formatInputNumber(temperaturePair.isaDeviationC, 1);
      tempEl.value = formatInputNumber(temperaturePair.temperatureC, 1);
      applyTemperatureFieldStyle({
        sourceUsed: temperaturePair.sourceUsed,
        isaDeviationEl: isaDevEl,
        temperatureEl: tempEl,
      });
      lastTempSource = temperaturePair.sourceUsed;

      const rows = [
        ["__section__", "Baseline Limits"],
        ["Optimum Altitude", `${format(limits.optimumAltFt, 0)} ft (FL${format(limits.optimumAltFt / 100, 0)})`],
        [
          "LRC Maximum Altitude / Thrust Limited",
          `${format(limits.maxAltFt, 0)} ft (FL${format(limits.maxAltFt / 100, 0)}) / ${limits.thrustLimited ? "Yes" : "No"}`,
        ],
        [
          "Engine Inoperative Maximum Altitude - SE LRC Altitude Capability (100 fpm)",
          `${format(seLrcCapability.altitudeFt, 0)} ft (FL${format(seLrcCapability.altitudeFt / 100, 0)})`,
        ],
        [
          "Driftdown Altitude",
          `${format(driftLevelOff.levelOffAltFt, 0)} ft (FL${format(driftLevelOff.levelOffAltFt / 100, 0)})`,
        ],
      ];

      if (hasTargetOptimum) {
        const targetWeightT = weightForNominatedOptimumAltitude(targetOptimumAltFt, limits.isaDeviationCUsed);
        const cruiseWeightAxis = (LRC_CRUISE_TABLE?.records || [])
          .map((record) => record.weightT)
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        const minCruiseWeightT = cruiseWeightAxis[0];
        const maxCruiseWeightT = cruiseWeightAxis[cruiseWeightAxis.length - 1];
        if (
          !Number.isFinite(minCruiseWeightT) ||
          !Number.isFinite(maxCruiseWeightT) ||
          weightT < minCruiseWeightT ||
          weightT > maxCruiseWeightT
        ) {
          throw new Error(
            `Current weight out of range for LRC fuel-flow lookup (${format(minCruiseWeightT, 1)}-${format(maxCruiseWeightT, 1)} t)`,
          );
        }

        const burnKgToTarget = Math.max(0, (weightT - targetWeightT) * 1000);
        let cruiseFuelFlowText = "Unavailable for this altitude";
        let timeText = burnKgToTarget > 0 ? "Unavailable for this altitude" : "Already reached";
        let climbPlanText = burnKgToTarget > 0 ? "Unavailable for this altitude" : "No climb required";
        try {
          const stepClimb = simulateStepClimbFuelToTargetWeight({
            startWeightT: weightT,
            targetWeightT,
            startFlightLevel: currentFl,
            targetOptimumAltFt,
            isaDeviationCUsed: limits.isaDeviationCUsed,
            perfAdjust,
          });
          cruiseFuelFlowText =
            burnKgToTarget > 0
              ? `${format(stepClimb.averageFuelFlowKgHr, 0)} kg/h avg (start ${format(stepClimb.initialFuelFlowKgHr, 0)} @ FL${format(currentFl, 0)})`
              : `${format(stepClimb.initialFuelFlowKgHr, 0)} kg/h @ FL${format(currentFl, 0)}`;
          if (burnKgToTarget > 0) {
            timeText = `${format(stepClimb.timeMinutes, 1)} min (${formatMinutes(stepClimb.timeMinutes)})`;
            climbPlanText = stepClimb.stepClimbs.length
              ? stepClimb.stepClimbs
                  .map((step) => `FL${format(step.altitudeFt / 100, 0)} @ ${format(step.atWeightT, 1)} t`)
                  .join(" -> ")
              : "No step climb before target weight";
          }
        } catch (error) {
          if (!String(error?.message || "").startsWith("LRC FL out of range")) {
            throw error;
          }
        }

        rows.push(
          ["__spacer__", ""],
          ["__section__", "New Optimum Altitude (optional)"],
          [
            "New Optimum Altitude",
            `${format(targetOptimumAltFt, 0)} ft (FL${format(targetOptimumAltFt / 100, 0)})`,
          ],
          ["Equivalent Weight", `${format(targetWeightT, 1)} t`],
          ["Current LRC Fuel Flow", cruiseFuelFlowText],
          ["Step Climb Plan", climbPlanText],
          ["Fuel to Burn to Equivalent Weight", `${format(burnKgToTarget, 0)} kg`],
          ["Time to Reach New Optimum Altitude", timeText],
          ["__spacer__", ""],
        );
      }

      if (limits.clampedToIsa10) {
        rows.push([
          "__warning__",
          `Maximum altitude note: ISA deviation floored to ISA+${format(limits.isaDeviationCUsed, 0)} (input ISA+${format(limits.isaDeviationCInput, 0)})`,
        ]);
      }
      if (eoWarnings.length) {
        rows.push(["__warning__", `Input warning: ${eoWarnings.join(" | ")}`]);
      }

      renderRows(out, rows);
    } catch (error) {
      renderError(out, error.message);
    }
  });

  applyTemperatureFieldStyle({
    sourceUsed: lastTempSource,
    isaDeviationEl: isaDevEl,
    temperatureEl: tempEl,
  });
  form.dispatchEvent(new Event("submit"));
}

function bindEngineOut() {
  const driftForm = document.querySelector("#engine-out-drift-form");
  const driftOut = document.querySelector("#engine-out-drift-out");
  const diversionForm = document.querySelector("#engine-out-diversion-form");
  const diversionOut = document.querySelector("#engine-out-diversion-out");

  if (driftForm && driftOut) {
    const weightEl = document.querySelector("#eo-weight");
    const isaDevEl = document.querySelector("#eo-isa-dev");
    const driftGnmEl = document.querySelector("#eo-drift-gnm");
    const driftWindEl = document.querySelector("#eo-drift-wind");

    driftForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (
        missingFieldsBanner(driftOut, [
          fieldIsBlank(weightEl.value) ? "Start Weight" : "",
          fieldIsBlank(isaDevEl.value) ? "ISA Deviation" : "",
          fieldIsBlank(driftGnmEl.value) ? "Engine out Cruise Distance" : "",
          fieldIsBlank(driftWindEl.value) ? "Driftdown Wind +/-" : "",
        ])
      ) {
        return;
      }

      try {
        const weightInputT = parseNum(weightEl.value);
        const isaDeviationCInput = parseNum(isaDevEl.value);
        const driftGnmInput = parseNum(driftGnmEl.value);
        const driftWindInputKt = parseNum(driftWindEl.value);
        const perfAdjust = getGlobalPerfAdjust();

        if (!Number.isFinite(weightInputT) || weightInputT <= 0) {
          throw new Error("Start weight must be > 0 t");
        }
        if (!Number.isFinite(isaDeviationCInput)) {
          throw new Error("ISA deviation is invalid");
        }
        if (!Number.isFinite(driftGnmInput)) {
          throw new Error("Engine out Cruise Distance is invalid");
        }
        if (!Number.isFinite(driftWindInputKt)) {
          throw new Error("Driftdown wind is invalid");
        }

        const driftdownRanges = getDriftdownRanges();
        const weightUsedT = clamp(weightInputT, driftdownRanges.minWeightT, driftdownRanges.maxWeightT);
        const driftGnmUsed = clamp(driftGnmInput, driftdownRanges.minGnm, driftdownRanges.maxGnm);
        const driftWindUsedKt = clamp(driftWindInputKt, driftdownRanges.minWindKt, driftdownRanges.maxWindKt);

        const warnings = [];
        if (weightUsedT !== weightInputT) {
          warnings.push(`Start weight clamped to ${format(weightUsedT, 1)} t`);
        }
        if (driftGnmUsed !== driftGnmInput) {
          warnings.push(`Engine out Cruise Distance clamped to ${format(driftGnmUsed, 0)} NM`);
        }
        if (driftWindUsedKt !== driftWindInputKt) {
          warnings.push(`Driftdown wind clamped to ${format(driftWindUsedKt, 0)} kt`);
        }

        const driftLevelOff = evaluateDriftdownLevelOff(weightUsedT, isaDeviationCInput);
        const driftAnm = driftdownAnmFromGnm(driftGnmUsed, driftWindUsedKt);
        const driftFuelTime = driftdownFuelAndTime(driftAnm, weightUsedT, perfAdjust);
        const seLrcCapability = singleEngineLrcCapabilityAltitude(weightUsedT, isaDeviationCInput);
        if (driftLevelOff.clampedToIsa10) {
          warnings.push(`ISA deviation floored to ISA+${format(driftLevelOff.isaDeviationCUsed, 0)}`);
        }
        const uniqueWarnings = [...new Set(warnings)];

        renderRows(driftOut, [
          ...(uniqueWarnings.length ? [["__warning__", `Input warning: ${uniqueWarnings.join(" | ")}`]] : []),
          [
            "ISA Deviation Used",
            driftLevelOff.clampedToIsa10
              ? `ISA+${format(driftLevelOff.isaDeviationCUsed, 0)} (input ISA+${format(isaDeviationCInput, 1)})`
              : `ISA+${format(driftLevelOff.isaDeviationCUsed, 1)}`,
          ],
          [
            "SE LRC Altitude Capability (100 fpm)",
            `${format(seLrcCapability.altitudeFt, 0)} ft (FL${format(seLrcCapability.altitudeFt / 100, 0)})`,
          ],
          ["Driftdown Start Weight", `${format(weightUsedT, 1)} t`],
          ["Driftdown Level Off Weight", `${format(driftLevelOff.levelOffWeightT, 1)} t`],
          ["Optimum Driftdown Speed", `${format(driftLevelOff.optimumDriftdownKias, 0)} kt`],
          [
            "Driftdown Level Off Altitude",
            `${format(driftLevelOff.levelOffAltFt, 0)} ft (FL${format(driftLevelOff.levelOffAltFt / 100, 0)})`,
          ],
          ["Driftdown Air Distance (ANM)", `${format(driftAnm, 0)} nm`],
          ["Driftdown + Cruise Fuel", `${format(driftFuelTime.fuelKg, 0)} kg`],
          ["Driftdown + Cruise Time", `${format(driftFuelTime.timeMinutes, 1)} min (${formatMinutes(driftFuelTime.timeMinutes)})`],
          ["__spacer__", ""],
        ]);
      } catch (error) {
        renderError(driftOut, error.message);
      }
    });

    driftForm.dispatchEvent(new Event("submit"));
  }

  if (diversionForm && diversionOut) {
    const eoDiversionWeightEl = document.querySelector("#eo-div-weight");
    const eoDiversionGnmEl = document.querySelector("#eo-div-gnm");
    const eoDiversionWindEl = document.querySelector("#eo-div-wind");
    const eoDiversionAltEl = document.querySelector("#eo-div-alt");

    diversionForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (
        missingFieldsBanner(diversionOut, [
          fieldIsBlank(eoDiversionWeightEl.value) ? "Start Weight" : "",
          fieldIsBlank(eoDiversionGnmEl.value) ? "EO LRC Diversion Distance" : "",
          fieldIsBlank(eoDiversionWindEl.value) ? "EO LRC Diversion Wind +/-" : "",
          fieldIsBlank(eoDiversionAltEl.value) ? "EO LRC Diversion Alt/FL" : "",
        ])
      ) {
        return;
      }

      try {
        const weightInputT = parseNum(eoDiversionWeightEl.value);
        const gnmInput = parseNum(eoDiversionGnmEl.value);
        const windInputKt = parseNum(eoDiversionWindEl.value);
        const eoDiversionAltInput = parseAltOrFlInput(eoDiversionAltEl.value, "EO LRC Diversion Alt/FL");
        const altitudeFt = eoDiversionAltInput.altitudeFt;
        const perfAdjust = getGlobalPerfAdjust();

        if (!Number.isFinite(weightInputT) || weightInputT <= 0) {
          throw new Error("Start weight must be > 0 t");
        }
        if (!Number.isFinite(gnmInput)) {
          throw new Error("EO LRC Diversion Distance is invalid");
        }
        if (!Number.isFinite(windInputKt)) {
          throw new Error("EO LRC Diversion Wind +/- is invalid");
        }
        if (eoDiversionAltInput.isThreeDigitFl) {
          eoDiversionAltEl.value = formatInputNumber(altitudeFt, 0);
        }

        const eoDiversion = eoDiversionFuelTime(gnmInput, windInputKt, altitudeFt, weightInputT, perfAdjust);
        renderRows(diversionOut, [
          ...(eoDiversion.warnings.length ? [["__warning__", `Input warning: ${eoDiversion.warnings.join(" | ")}`]] : []),
          [
            "EO Diversion Altitude Used",
            `${format(eoDiversion.usedInputs.altitudeFt, 0)} ft (FL${format(eoDiversion.usedInputs.altitudeFt / 100, 0)})`,
          ],
          ["EO Diversion Air Distance (ANM)", `${format(eoDiversion.anm, 0)} nm`],
          ["EO Diversion Reference Fuel", `${format(eoDiversion.referenceFuel1000Kg * 1000, 0)} kg`],
          ["EO Diversion Weight Adjustment", `${format(eoDiversion.adjustment1000Kg * 1000, 0)} kg`],
          ["EO Diversion Flight Fuel", `${format(eoDiversion.flightFuelKg, 0)} kg`],
          ["EO Diversion Time", `${format(eoDiversion.timeMinutes, 1)} min (${formatMinutes(eoDiversion.timeMinutes)})`],
        ]);
      } catch (error) {
        renderError(diversionOut, error.message);
      }
    });

    diversionForm.dispatchEvent(new Event("submit"));
  }
}

function bindDiversion() {
  const form = document.querySelector("#diversion-form");
  const out = document.querySelector("#diversion-out");
  if (!form || !out) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (
      missingFieldsBanner(out, [
        fieldIsBlank(document.querySelector("#div-gnm").value) ? "Ground Distance (GNM)" : "",
        fieldIsBlank(document.querySelector("#div-wind").value) ? "Wind +/-" : "",
        fieldIsBlank(document.querySelector("#div-alt").value) ? "Alt/FL" : "",
        fieldIsBlank(document.querySelector("#div-weight").value) ? "Start Weight" : "",
        fieldIsBlank(document.querySelector("#div-hold-min").value) ? "Additional Holding Fuel (min)" : "",
      ])
    ) {
      return;
    }
    try {
      const gnm = parseNum(document.querySelector("#div-gnm").value);
      const wind = parseNum(document.querySelector("#div-wind").value);
      const divAltEl = document.querySelector("#div-alt");
      const divAltInput = parseAltOrFlInput(divAltEl.value, "Diversion Alt/FL");
      const altitudeFt = divAltInput.altitudeFt;
      const weightT = parseNum(document.querySelector("#div-weight").value);
      const holdingMin = parseNum(document.querySelector("#div-hold-min").value);
      const perfAdjust = getGlobalPerfAdjust();
      if (divAltInput.isThreeDigitFl) {
        divAltEl.value = formatInputNumber(altitudeFt, 0);
      }

      const result = diversionLrcFuel(gnm, wind, altitudeFt, weightT, perfAdjust, holdingMin);
      const rows = [
        ...(result.warnings.length ? [["__warning__", `Input warning: ${result.warnings.join(" | ")}`]] : []),
        ["Flight Fuel", `${format(result.adjustedFuel1000Kg * 1000, 0)} kg`],
        ["Est Landing Weight", `${format(result.reserveCalcWeightT, 1)} t`],
        ["FRF (30 min hold @ 1500 ft)", `${format(result.frfKg, 0)} kg`],
        ["Contingency Fuel (5%, min 350, max 1200)", `${format(result.contingencyKg, 0)} kg`],
        [`Additional Holding Fuel (${format(holdingMin, 1)} min)`, `${format(result.extraHoldingKg, 0)} kg`],
        ["Approach Fuel", `${format(result.fixedAllowanceKg, 0)} kg`],
        ["Total Fuel Required", `${format(result.totalFuelKg, 0)} kg`],
        ["Time", formatMinutes(result.timeMinutes)],
      ];
      renderRows(out, rows);
    } catch (error) {
      renderError(out, error.message);
    }
  });

  form.dispatchEvent(new Event("submit"));
}

function bindHolding() {
  const form = document.querySelector("#holding-form");
  const out = document.querySelector("#holding-out");
  const totalHoldEl = document.querySelector("#hold-total-min");
  const inboundLegEl = document.querySelector("#hold-inbound-min");
  const timingIsaDevEl = document.querySelector("#hold-timing-isa-dev");
  const timingTempEl = document.querySelector("#hold-timing-temp");
  let lastTimingSource = totalHoldEl.value.trim() !== "" ? "total" : "inbound";
  let lastTempSource = "isa-dev";

  function chooseTimingSource(source) {
    if (source === "total" && totalHoldEl.value.trim() !== "") {
      inboundLegEl.value = "";
      lastTimingSource = "total";
    } else if (source === "inbound" && inboundLegEl.value.trim() !== "") {
      totalHoldEl.value = "";
      lastTimingSource = "inbound";
    }
  }

  totalHoldEl.addEventListener("input", () => chooseTimingSource("total"));
  totalHoldEl.addEventListener("change", () => chooseTimingSource("total"));
  inboundLegEl.addEventListener("input", () => chooseTimingSource("inbound"));
  inboundLegEl.addEventListener("change", () => chooseTimingSource("inbound"));
  timingIsaDevEl.addEventListener("input", () => {
    lastTempSource = "isa-dev";
  });
  timingTempEl.addEventListener("input", () => {
    lastTempSource = "temp";
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const totalHoldRaw = String(totalHoldEl.value || "").trim();
    const inboundLegRaw = String(inboundLegEl.value || "").trim();
    if (
      missingFieldsBanner(out, [
        fieldIsBlank(document.querySelector("#hold-weight").value) ? "Weight" : "",
        fieldIsBlank(document.querySelector("#hold-alt").value) ? "Alt/FL" : "",
        fieldIsBlank(document.querySelector("#fuel-available").value) ? "Fuel Available" : "",
        fieldIsBlank(document.querySelector("#hold-inbound-course").value) ? "Inbound Course" : "",
        fieldIsBlank(document.querySelector("#hold-wind-dir").value) ? "Wind Direction" : "",
        fieldIsBlank(document.querySelector("#hold-wind-speed").value) ? "Wind Speed" : "",
      ])
    ) {
      return;
    }
    if (totalHoldRaw === "" && inboundLegRaw === "") {
      renderValidation(out, "Missing required input: Total Hold Required or Inbound Leg Time");
      return;
    }
    if (fieldIsBlank(timingIsaDevEl.value) && fieldIsBlank(timingTempEl.value)) {
      renderValidation(out, "Missing required input: ISA Deviation or Temperature");
      return;
    }
    try {
      const weight = parseNum(document.querySelector("#hold-weight").value);
      const holdAltEl = document.querySelector("#hold-alt");
      const holdAltInput = parseAltOrFlInput(holdAltEl.value, "Alt/FL");
      const altitude = holdAltInput.altitudeFt;
      const fuelAvailable = parseNum(document.querySelector("#fuel-available").value);
      const perfAdjust = getGlobalPerfAdjust();
      const holdSide = String(document.querySelector("#hold-side").value || "R").toUpperCase();
      const inboundCourseDeg = parseNum(document.querySelector("#hold-inbound-course").value);
      const windFromDeg = parseNum(document.querySelector("#hold-wind-dir").value);
      const windSpeedKt = parseNum(document.querySelector("#hold-wind-speed").value);
      const timingIasRaw = String(document.querySelector("#hold-timing-ias").value || "").trim();
      const bankLimitRaw = String(document.querySelector("#hold-bank-limit").value || "").trim();
      const temperaturePair = resolveTemperaturePair({
        isaDeviationRaw: timingIsaDevEl.value,
        temperatureRaw: timingTempEl.value,
        lastSource: lastTempSource,
        pressureAltitudeFt: altitude,
        label: "Holding timing temperature",
      });
      const timingIsaDevC = temperaturePair.isaDeviationC;

      if (holdAltInput.isThreeDigitFl) {
        holdAltEl.value = formatInputNumber(altitude, 0);
      }
      timingIsaDevEl.value = formatInputNumber(temperaturePair.isaDeviationC, 1);
      timingTempEl.value = formatInputNumber(temperaturePair.temperatureC, 1);
      applyTemperatureFieldStyle({
        sourceUsed: temperaturePair.sourceUsed,
        isaDeviationEl: timingIsaDevEl,
        temperatureEl: timingTempEl,
      });
      lastTempSource = temperaturePair.sourceUsed;

      if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error("Weight must be > 0 t");
      }
      if (FLAPS_UP_TABLE && Array.isArray(FLAPS_UP_TABLE.altitudesFt) && FLAPS_UP_TABLE.altitudesFt.length > 1) {
        const minAlt = FLAPS_UP_TABLE.altitudesFt[0];
        const maxAlt = FLAPS_UP_TABLE.altitudesFt[FLAPS_UP_TABLE.altitudesFt.length - 1];
        if (altitude < minAlt || altitude > maxAlt) {
          throw new Error(`Altitude out of range (${format(minAlt, 0)}-${format(maxAlt, 0)} ft)`);
        }
      }
      if (!Number.isFinite(fuelAvailable) || fuelAvailable < 0) {
        throw new Error("Fuel available must be >= 0 kg");
      }
      if (!Number.isFinite(inboundCourseDeg) || inboundCourseDeg < 0) {
        throw new Error("Inbound course must be >= 0 deg");
      }
      if (!Number.isFinite(windFromDeg) || windFromDeg < 0) {
        throw new Error("Wind direction must be >= 0 deg");
      }
      if (!Number.isFinite(windSpeedKt) || windSpeedKt < 0) {
        throw new Error("Wind speed must be >= 0 kt");
      }

      let timingMode;
      if (totalHoldRaw !== "" && inboundLegRaw !== "") {
        if (lastTimingSource === "inbound") {
          totalHoldEl.value = "";
          timingMode = "given-inbound";
        } else {
          inboundLegEl.value = "";
          timingMode = "given-total";
        }
      } else if (totalHoldRaw !== "") {
        timingMode = "given-total";
        lastTimingSource = "total";
      } else if (inboundLegRaw !== "") {
        timingMode = "given-inbound";
        lastTimingSource = "inbound";
      } else {
        throw new Error("Enter Total hold required or Inbound leg time");
      }

      const totalHoldMin = timingMode === "given-total" ? parseNum(totalHoldEl.value) : NaN;
      const inboundLegMin = timingMode === "given-inbound" ? parseNum(inboundLegEl.value) : NaN;
      const bankLimitDeg = bankLimitRaw === "" ? DEFAULT_HOLD_BANK_DEG : parseNum(bankLimitRaw);
      if (!Number.isFinite(bankLimitDeg) || bankLimitDeg <= 0 || bankLimitDeg >= 90) {
        throw new Error("Bank limit must be > 0 and < 90 deg");
      }

      if (timingMode === "given-total") {
        if (!Number.isFinite(totalHoldMin) || totalHoldMin < 0) {
          throw new Error("Total hold required must be >= 0 min");
        }
      } else if (timingMode === "given-inbound") {
        if (!Number.isFinite(inboundLegMin) || inboundLegMin <= 0) {
          throw new Error("Inbound leg time must be > 0 min");
        }
      } else {
        throw new Error("Unknown hold timing mode");
      }

      const hold = holdingAt(weight, altitude, 0, perfAdjust);
      const useManualTimingIas = timingIasRaw !== "";
      const timingIasKt = useManualTimingIas ? parseNum(timingIasRaw) : hold.kias;

      const endurance = (fuelAvailable / hold.fuelHr) * 60;
      const rows = [
        ["Hold Command IAS (table)", `${format(hold.kias, 0)} kt`],
        ["Hold Fuel Flow", `${format(hold.fuelHr, 0)} kg/h`],
        ["Hold less 5%", `${format(hold.lessFivePct, 0)} kg/h`],
        ["Hold Endurance", formatMinutes(endurance)],
      ];

      if (timingMode === "given-total" && totalHoldMin === 0) {
        renderRows(out, rows);
        return;
      }

      const timing = calculateHoldTiming({
        mode: timingMode,
        totalHoldMin,
        inboundLegMin,
        holdSide,
        inboundCourseDeg,
        windFromDeg,
        windSpeedKt,
        pressureAltitudeFt: altitude,
        iasKt: timingIasKt,
        isaDeviationC: timingIsaDevC,
        bankLimitDeg,
      });

      rows.push(
        ["__spacer__", ""],
        ["Hold Timing Input Mode", timingMode === "given-total" ? "Given Total Hold Time" : "Given Inbound Leg Time"],
        [
          "Inbound Leg (actual GS time to fix)",
          `${format(timing.inboundLegMin, 2)} min (${formatMinutes(timing.inboundLegMin)})`,
        ],
        ["Outbound Leg (wind-corrected)", `${format(timing.outboundLegMin, 2)} min`],
        [
          "Total Hold Time (fix crossing to fix crossing)",
          `${format(timing.totalHoldMin, 2)} min (${formatMinutes(timing.totalHoldMin)})`,
        ],
        ["Timing IAS / TAS / Mach", `${format(timing.iasKt, 0)} / ${format(timing.tasKt, 0)} kt / ${format(timing.mach, 3)}`],
        ["Inbound / Outbound Track", `${format(timing.inboundTrackDeg, 0)}° / ${format(timing.outboundTrackDeg, 0)}°`],
        ["Inbound / Outbound Heading", `${format(timing.inboundHeadingDeg, 0)}° / ${format(timing.outboundHeadingDeg, 0)}°`],
        [
          "Inbound / Outbound GS",
          `${format(timing.inboundGroundSpeedKt, 0)} / ${format(timing.outboundGroundSpeedKt, 0)} kt`,
        ],
        ["Leg Distance", `${format((timing.inboundLegNm + timing.outboundLegNm) / 2, 2)} NM`],
        [
          "Turn 1 / Turn 2",
          `${format(timing.turn1Deg, 1)}° (${format(timing.turn1Min, 2)} min @ ${format(timing.turn1BankDeg, 1)}° bank) / ${format(timing.turn2Deg, 1)}° (${format(timing.turn2Min, 2)} min @ ${format(timing.turn2BankDeg, 1)}° bank)`,
        ],
        ["Turn Total", `${format(timing.totalTurnMin, 2)} min`],
        ["Turn Radius (common)", `${format(timing.turnRadiusNm, 2)} NM`],
      );
      renderRows(out, rows);
    } catch (error) {
      renderError(out, error.message);
    }
  });

  chooseTimingSource("total");
  applyTemperatureFieldStyle({
    sourceUsed: lastTempSource,
    isaDeviationEl: timingIsaDevEl,
    temperatureEl: timingTempEl,
  });
  form.dispatchEvent(new Event("submit"));
}

function bindLoseTime() {
  const form = document.querySelector("#lose-time-form");
  const out = document.querySelector("#lose-time-out");
  const levelModeEl = document.querySelector("#lt-level-change-mode");
  const changeAfterEl = document.querySelector("#lt-change-after-min");
  const newFlEl = document.querySelector("#lt-new-fl");

  function toggleInputs() {
    const levelNone = levelModeEl.value === "none";
    changeAfterEl.disabled = levelNone;
    newFlEl.disabled = levelNone;
  }

  levelModeEl.addEventListener("change", () => {
    toggleInputs();
    form.dispatchEvent(new Event("submit"));
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (
      missingFieldsBanner(out, [
        fieldIsBlank(document.querySelector("#lt-distance").value) ? "Distance to Fix" : "",
        fieldIsBlank(document.querySelector("#lt-weight").value) ? "Current Weight" : "",
        fieldIsBlank(document.querySelector("#lt-fl").value) ? "Current Alt/FL" : "",
        fieldIsBlank(document.querySelector("#lt-delay").value) ? "Required Delay" : "",
        fieldIsBlank(document.querySelector("#lt-wind").value) ? "Wind" : "",
      ])
    ) {
      return;
    }
    if (levelModeEl.value !== "none") {
      if (
        missingFieldsBanner(out, [
          fieldIsBlank(changeAfterEl.value) ? "Change After (min)" : "",
          fieldIsBlank(newFlEl.value) ? "New Alt/FL" : "",
        ])
      ) {
        return;
      }
    }

    try {
      const distanceNm = parseNum(document.querySelector("#lt-distance").value);
      const startWeightT = parseNum(document.querySelector("#lt-weight").value);
      const startFlEl = document.querySelector("#lt-fl");
      const startFlInput = parseAltOrFlInput(startFlEl.value, "Current Alt/FL");
      const startFl = startFlInput.flightLevel;
      const requiredDelayMin = parseNum(document.querySelector("#lt-delay").value);
      const windKt = parseNum(document.querySelector("#lt-wind").value);
      const perfAdjust = getGlobalPerfAdjust();
      const levelChangeMode = levelModeEl.value;
      const newFl =
        levelChangeMode === "none"
          ? startFl
          : parseAltOrFlInput(newFlEl.value, "New Alt/FL").flightLevel;
      validateLrcFlightLevelRange(startFl, "Current Alt/FL");
      if (levelChangeMode !== "none") {
        validateLrcFlightLevelRange(newFl, "New Alt/FL");
      }

      if (!startFlInput.isThreeDigitFl) {
        startFlEl.value = formatInputNumber(startFl, 0);
      }
      if (levelChangeMode !== "none") {
        const newFlInput = parseAltOrFlInput(newFlEl.value, "New Alt/FL");
        if (!newFlInput.isThreeDigitFl) {
          newFlEl.value = formatInputNumber(newFl, 0);
        }
      }

      const levelChange = {
        mode: levelChangeMode,
        afterMin: parseNum(changeAfterEl.value),
        newFl,
      };
      const levelChangeSummary =
        levelChangeMode === "none"
          ? "None"
          : `${levelChangeMode === "climb" ? "Climb" : "Descent"} to FL${format(levelChange.newFl, 0)} after ${format(levelChange.afterMin, 0)} min`;

      const comparison = buildLoseTimeComparison({
        distanceNm,
        startWeightT,
        startFl,
        requiredDelayMin,
        cruiseWindKt: windKt,
        holdWindKt: windKt,
        levelChange,
        perfAdjust,
      });

      const switchInfo = comparison.optionB.switchInfo;
      const switchText = switchInfo
        ? `${formatMinutes(switchInfo.atElapsedMin)} elapsed, ${format(switchInfo.remainingNmAtSwitch, 1)} NM to fix`
        : "No enroute speed reduction needed";
      const optionCRows = comparison.optionC
        ? [
            ["Time to Fix (target)", formatMinutes(comparison.targetFixTime)],
            ["Required Average Ground Speed", `${format(comparison.optionC.requiredGsKt, 0)} kt`],
            [
              "Required IAS / Mach",
              `${format(comparison.optionC.requiredIasKt, 0)} kt / ${format(comparison.optionC.requiredMach, 3)}`,
            ],
          ]
        : [["Required Speed Solution", comparison.optionCError || "Unable to compute required speed"]];

      renderRows(out, [
        ["Start FL (used)", `FL${format(startFl, 0)}`],
        ["Level Change (used)", levelChangeSummary],
        ["Required Delay", `${format(requiredDelayMin, 2)} min`],
        ["Baseline LRC Time to Fix", formatMinutes(comparison.baseline.timeToFixMin)],
        ["Baseline LRC Fuel to Fix", `${format(comparison.baseline.fuelBurnKg, 0)} kg`],
        ["__spacer__", ""],
        ["Option A Time (LRC + Hold at Fix)", formatMinutes(comparison.optionA.totalTimeMin)],
        ["Option A Fuel Burn", `${format(comparison.optionA.fuelBurnKg, 0)} kg`],
        ["Option A Delay Achieved", `${format(comparison.optionA.totalTimeMin - comparison.baseline.timeToFixMin, 2)} min`],
        ["__spacer__", ""],
        ["Option B Time (Enroute Hold-Speed)", formatMinutes(comparison.optionB.totalTimeMin)],
        ["Option B Fuel Burn", `${format(comparison.optionB.fuelBurnKg, 0)} kg`],
        ["Option B Delay Achieved", `${format(comparison.optionB.totalTimeMin - comparison.baseline.timeToFixMin, 2)} min`],
        ["Option B Speed Reduction Start", switchText],
        ["Option B Residual Hold at Fix", `${format(comparison.residualHoldMin, 2)} min`],
        ["__spacer__", ""],
        ...optionCRows,
        ["__spacer__", ""],
        ["Fuel Difference (A - B)", `${format(comparison.optionA.fuelBurnKg - comparison.optionB.fuelBurnKg, 0)} kg`],
        ["Final Weight Option A / B", `${format(comparison.optionA.finalWeightT, 2)} / ${format(comparison.optionB.finalWeightT, 2)} t`],
      ]);
    } catch (error) {
      renderError(out, error.message);
    }
  });

  toggleInputs();
  form.dispatchEvent(new Event("submit"));
}

function bindConversion() {
  const form = document.querySelector("#conversion-form");
  const out = document.querySelector("#conversion-out");
  const modeEl = document.querySelector("#conv-mode");
  const iasEl = document.querySelector("#conv-ias");
  const machEl = document.querySelector("#conv-mach");
  const tasEl = document.querySelector("#conv-tas");
  const flEl = document.querySelector("#conv-fl");
  const oatEl = document.querySelector("#conv-oat");
  const isaDevEl = document.querySelector("#conv-isa-dev");
  let lastTempSource = "temp";

  function toggleInputs() {
    const mode = modeEl.value;
    iasEl.disabled = mode !== "ias";
    machEl.disabled = mode !== "mach";
    tasEl.disabled = mode !== "tas";
  }

  modeEl.addEventListener("change", () => {
    toggleInputs();
    form.dispatchEvent(new Event("submit"));
  });
  isaDevEl.addEventListener("input", () => {
    lastTempSource = "isa-dev";
  });
  oatEl.addEventListener("input", () => {
    lastTempSource = "temp";
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const mode = modeEl.value;
    if (fieldIsBlank(flEl.value)) {
      renderValidation(out, "Missing required input: Alt/FL");
      return;
    }
    if (fieldIsBlank(isaDevEl.value) && fieldIsBlank(oatEl.value)) {
      renderValidation(out, "Missing required input: ISA Deviation or Temperature");
      return;
    }
    if (
      (mode === "ias" && fieldIsBlank(iasEl.value)) ||
      (mode === "mach" && fieldIsBlank(machEl.value)) ||
      (mode === "tas" && fieldIsBlank(tasEl.value))
    ) {
      renderValidation(
        out,
        `Missing required input: ${mode === "ias" ? "IAS" : mode === "mach" ? "Mach" : "TAS"}`,
      );
      return;
    }
    try {
      const flInput = parseAltOrFlInput(flEl.value, "Alt/FL");
      const fl = flInput.flightLevel;
      const pressureAltitudeFt = fl * 100;
      const temperaturePair = resolveTemperaturePair({
        isaDeviationRaw: isaDevEl.value,
        temperatureRaw: oatEl.value,
        lastSource: lastTempSource,
        pressureAltitudeFt,
        label: "IAS/Mach/TAS temperature",
      });
      lastTempSource = temperaturePair.sourceUsed;
      isaDevEl.value = formatInputNumber(temperaturePair.isaDeviationC, 1);
      oatEl.value = formatInputNumber(temperaturePair.temperatureC, 1);
      applyTemperatureFieldStyle({
        sourceUsed: temperaturePair.sourceUsed,
        isaDeviationEl: isaDevEl,
        temperatureEl: oatEl,
      });

      if (!flInput.isThreeDigitFl) {
        flEl.value = formatInputNumber(fl, 0);
      }
      const atmosphere = atmosphereFromPressureAltitude({
        pressureAltitudeFt,
        tempMode: temperaturePair.sourceUsed === "temp" ? "oat" : "isa-dev",
        oatC: temperaturePair.temperatureC,
        isaDeviationC: temperaturePair.isaDeviationC,
      });

      let result;
      if (mode === "ias") {
        result = iasToMachTas({
          iasKt: parseNum(iasEl.value),
          pressurePa: atmosphere.pressurePa,
          speedOfSoundMps: atmosphere.speedOfSoundMps,
        });
      } else if (mode === "mach") {
        result = machToIasTas({
          mach: parseNum(machEl.value),
          pressurePa: atmosphere.pressurePa,
          speedOfSoundMps: atmosphere.speedOfSoundMps,
        });
      } else {
        result = tasToIasMach({
          tasKt: parseNum(tasEl.value),
          pressurePa: atmosphere.pressurePa,
          speedOfSoundMps: atmosphere.speedOfSoundMps,
        });
      }

      renderRows(out, [
        ["IAS", `${format(result.iasKt, 0)} kt`],
        ["Mach", format(result.mach, 3)],
        ["TAS", `${format(result.tasKt, 0)} kt`],
        ["Pressure Altitude Used", `${format(pressureAltitudeFt, 0)} ft`],
        ["Geopotential Altitude", `${format(atmosphere.geopotentialM * M_TO_FT, 0)} ft`],
        ["ISA Temp", `${format(atmosphere.isaTempK - 273.15, 1)} °C`],
        ["Actual Temp", `${format(atmosphere.actualTempK - 273.15, 1)} °C`],
      ]);
    } catch (error) {
      renderError(out, error.message);
    }
  });

  toggleInputs();
  applyTemperatureFieldStyle({
    sourceUsed: lastTempSource,
    isaDeviationEl: isaDevEl,
    temperatureEl: oatEl,
  });
  form.dispatchEvent(new Event("submit"));
}

function bindGoAround() {
  const form = document.querySelector("#go-around-form");
  const out = document.querySelector("#go-around-out");
  if (!form || !out) return;

  const flapEl = document.querySelector("#go-around-flap");
  const oatEl = document.querySelector("#go-around-oat");
  const elevationEl = document.querySelector("#go-around-elevation");
  const weightEl = document.querySelector("#go-around-weight");
  const targetGradientEl = document.querySelector("#go-around-target-gradient");
  const speedEl = document.querySelector("#go-around-speed");
  const antiIceEl = document.querySelector("#go-around-anti-ice");
  const icingPenaltyEl = document.querySelector("#go-around-icing-penalty");

  const setRangeText = (selector, text) => {
    const el = document.querySelector(selector);
    if (el) el.textContent = text;
  };

  const updateFlapDependentUi = () => {
    const config = getGoAroundConfig(flapEl.value);
    const ranges = getGoAroundRanges(config);

    setRangeText("#go-around-oat-range", `(${format(ranges.minOatC, 0)}-${format(ranges.maxOatC, 0)})`);
    setRangeText("#go-around-elev-range", `(${format(ranges.minAltitudeFt, 0)}-${format(ranges.maxAltitudeFt, 0)})`);
    setRangeText("#go-around-weight-range", `(${format(ranges.minWeightT, 0)}-${format(ranges.maxWeightT, 0)})`);

    const previousSpeed = speedEl.value;
    const speedOptions = config.speedAdjustment.rows.map((row) => row.speed);
    speedEl.innerHTML = speedOptions.map((speed) => `<option value="${speed}">${speed}</option>`).join("");
    if (speedOptions.includes(previousSpeed)) {
      speedEl.value = previousSpeed;
    } else {
      const preferred = speedOptions.find((speed) => speed.includes("+5")) || speedOptions[0];
      speedEl.value = preferred;
    }
  };

  flapEl.addEventListener("change", () => {
    updateFlapDependentUi();
    form.dispatchEvent(new Event("submit"));
  });

  const chooseInputMode = (source) => {
    if (source === "target" && targetGradientEl.value.trim() !== "") {
      weightEl.value = "";
    } else if (source === "weight" && weightEl.value.trim() !== "") {
      targetGradientEl.value = "";
    }
  };

  weightEl.addEventListener("input", () => {
    chooseInputMode("weight");
  });
  targetGradientEl.addEventListener("input", () => {
    chooseInputMode("target");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (
      missingFieldsBanner(out, [
        fieldIsBlank(oatEl.value) ? "OAT" : "",
        fieldIsBlank(elevationEl.value) ? "Airport Elevation" : "",
      ])
    ) {
      return;
    }
    if (fieldIsBlank(weightEl.value) && fieldIsBlank(targetGradientEl.value)) {
      renderValidation(out, "Missing required input: Landing Weight or Target Gradient");
      return;
    }
    try {
      const oatText = oatEl.value.trim();
      const elevationText = elevationEl.value.trim();
      const weightText = weightEl.value.trim();
      const targetText = targetGradientEl.value.trim();

      const result = calculateGoAroundGradient({
        flapSelection: flapEl.value,
        oatCInput: oatText === "" ? NaN : parseNum(oatText),
        elevationFtInput: elevationText === "" ? NaN : parseNum(elevationText),
        landingWeightTInput: weightText === "" ? NaN : parseNum(weightText),
        targetGradientPctInput: targetText === "" ? NaN : parseNum(targetText),
        speedLabel: speedEl.value,
        antiIceMode: antiIceEl.value,
        applyIcingPenalty: icingPenaltyEl.value === "on",
      });

      oatEl.value = formatInputNumber(result.inputsUsed.oatC, 1);
      elevationEl.value = formatInputNumber(result.inputsUsed.elevationFt, 0);
      if (result.mode === "weight") {
        weightEl.value = formatInputNumber(result.inputsUsed.landingWeightT, 1);
      } else {
        targetGradientEl.value = formatInputNumber(result.targetGradientPct, 1);
      }

      const rows = [
        ...(result.warnings.length ? [["__warning__", `Input warning: ${result.warnings.join(" | ")}`]] : []),
        ["Flap / Speed", `${result.flapLabel} / ${result.inputsUsed.speedLabel}`],
        ["OAT / Airport Elevation Used", `${format(result.inputsUsed.oatC, 1)} °C / ${format(result.inputsUsed.elevationFt, 0)} ft`],
        ["Anti-Ice Band Applied", result.antiIceBand],
        ...(result.mode === "target"
          ? [
              ["Target Gradient", `${format(result.targetGradientPct, 1)} %`],
              ["Required Landing Weight", `${format(result.inputsUsed.landingWeightT, 1)} t`],
            ]
          : []),
        ["Reference Gradient", `${format(result.referenceGradientPct, 1)} %`],
        ["Weight Adjustment", `${format(result.weightAdjustmentPct, 1)} %`],
        ["Speed Adjustment", `${format(result.speedAdjustmentPct, 1)} %`],
        ["Anti-Ice Adjustment", `${format(result.antiIceAdjustmentPct, 1)} %`],
        ["Icing Penalty", `${format(result.icingPenaltyPct, 1)} %`],
        ["Final Go-Around Gradient", `${format(result.finalGradientPct, 1)} %`],
      ];
      renderRows(out, rows);
    } catch (error) {
      renderError(out, error.message);
    }
  });

  updateFlapDependentUi();
  form.dispatchEvent(new Event("submit"));
}

function bindGlobalSettings() {
  const globalPerfEl = document.querySelector("#global-perf-adjust");
  if (!globalPerfEl) return;

  const refreshAll = () => {
    [
      "#trip-fuel-form",
      "#lrc-altitude-form",
      "#engine-out-drift-form",
      "#engine-out-diversion-form",
      "#diversion-form",
      "#holding-form",
      "#lose-time-form",
    ].forEach((selector) => {
      const form = document.querySelector(selector);
      if (form) form.dispatchEvent(new Event("submit"));
    });
  };

  globalPerfEl.addEventListener("change", refreshAll);
}

function setAltFlRangeLabels() {
  const setRangeText = (selector, text) => {
    const el = document.querySelector(selector);
    if (el) el.textContent = text;
  };

  const formatFlRange = (minFl, maxFl) => {
    if (!Number.isFinite(minFl) || !Number.isFinite(maxFl)) return "";
    return `(FL${format(minFl, 0)}-${format(maxFl, 0)})`;
  };

  const holdAltAxis = FLAPS_UP_TABLE?.altitudesFt;
  if (Array.isArray(holdAltAxis) && holdAltAxis.length > 1) {
    const minFl = holdAltAxis[0] / 100;
    const maxFl = holdAltAxis[holdAltAxis.length - 1] / 100;
    setRangeText("#hold-alt-range", formatFlRange(minFl, maxFl));
  }

  const diversionRange = getDiversionAltitudeRangeFt();
  if (Number.isFinite(diversionRange.minFt) && Number.isFinite(diversionRange.maxFt)) {
    setRangeText("#div-alt-range", formatFlRange(diversionRange.minFt / 100, diversionRange.maxFt / 100));
  }

  const { minFl, maxFl } = getLrcTableFlRange();
  const lrcRangeText = formatFlRange(minFl, maxFl);
  setRangeText("#lt-fl-range", lrcRangeText);
  setRangeText("#lt-new-fl-range", lrcRangeText);
  setRangeText("#lrc-alt-current-range", lrcRangeText);

  const altLimitRanges = getLrcAltitudeLimitsRanges();
  if (Number.isFinite(altLimitRanges.minOptimumAltFt) && Number.isFinite(altLimitRanges.maxOptimumAltFt)) {
    setRangeText(
      "#lrc-alt-target-range",
      formatFlRange(altLimitRanges.minOptimumAltFt / 100, altLimitRanges.maxOptimumAltFt / 100),
    );
  }

  const driftdownRanges = getDriftdownRanges();
  if (Number.isFinite(driftdownRanges.minGnm) && Number.isFinite(driftdownRanges.maxGnm)) {
    setRangeText("#eo-drift-gnm-range", `(${format(driftdownRanges.minGnm, 0)}-${format(driftdownRanges.maxGnm, 0)})`);
  }
  if (Number.isFinite(driftdownRanges.minWindKt) && Number.isFinite(driftdownRanges.maxWindKt)) {
    setRangeText(
      "#eo-drift-wind-range",
      `(${format(driftdownRanges.minWindKt, 0)} to +${format(driftdownRanges.maxWindKt, 0)})`,
    );
  }

  const eoDiversionRanges = getEoDiversionRanges();
  if (Number.isFinite(eoDiversionRanges.minGnm) && Number.isFinite(eoDiversionRanges.maxGnm)) {
    setRangeText("#eo-div-gnm-range", `(${format(eoDiversionRanges.minGnm, 0)}-${format(eoDiversionRanges.maxGnm, 0)})`);
  }
  if (Number.isFinite(eoDiversionRanges.minWindKt) && Number.isFinite(eoDiversionRanges.maxWindKt)) {
    setRangeText(
      "#eo-div-wind-range",
      `(${format(eoDiversionRanges.minWindKt, 0)} to +${format(eoDiversionRanges.maxWindKt, 0)})`,
    );
  }
  if (Number.isFinite(eoDiversionRanges.minAltitudeFt) && Number.isFinite(eoDiversionRanges.maxAltitudeFt)) {
    setRangeText(
      "#eo-div-alt-range",
      formatFlRange(eoDiversionRanges.minAltitudeFt / 100, eoDiversionRanges.maxAltitudeFt / 100),
    );
  }

  const maxGeopotentialM = ISA_LAYER_BASES_M[ISA_LAYER_BASES_M.length - 1];
  const maxGeometricM = (EARTH_RADIUS_M * maxGeopotentialM) / (EARTH_RADIUS_M - maxGeopotentialM);
  const maxIsaFl = (maxGeometricM * M_TO_FT) / 100;
  setRangeText("#conv-fl-range", `(>0 to FL${format(maxIsaFl, 0)})`);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker
    .register("./sw.js")
    .then((registration) => {
      registration.update().catch(() => {});

      const activateWaitingWorker = () => {
        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      };

      activateWaitingWorker();
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            activateWaitingWorker();
          }
        });
      });
    })
    .catch(() => {});
}

function setAppVersionLabel() {
  const versionEl = document.querySelector("#app-version");
  if (versionEl) {
    versionEl.textContent = `Version ${APP_VERSION}`;
  }
}

setAppVersionLabel();
setAltFlRangeLabels();
restorePersistedInputState();
installInputStatePersistence();
bindTripFuel();
bindLrcAltitudeLimits();
bindEngineOut();
bindDiversion();
bindGoAround();
bindHolding();
bindLoseTime();
bindConversion();
bindGlobalSettings();
registerServiceWorker();
