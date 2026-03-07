const TABLE_DATA = window.TABLE_DATA;
const LRC_CRUISE_TABLE = window.LRC_CRUISE_TABLE;
const FLAPS_UP_TABLE = window.FLAPS_UP_TABLE;
const DIVERSION_LRC_TABLE = window.DIVERSION_LRC_TABLE;

const { shortTripAnm, longRangeAnm, longRangeFuel: longRangeFuelTable, shortTripFuelAlt } = TABLE_DATA;

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
const HOLD_MAX_BANK_DEG = 25;
const FIXED_ALLOWANCE_KG = 200;
const MIN_CONTINGENCY_KG = 350;
const MAX_CONTINGENCY_KG = 1200;
const ENROUTE_HOLD_SPEED_FUEL_FACTOR = 0.95;
const LOSE_TIME_CLIMB_RATE_FPM = 1000;
const LOSE_TIME_DESCENT_RATE_FPM = 1000;

function parseNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeFlightLevelInput(rawValue, label = "Flight level") {
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    throw new Error(`${label} must be > 0`);
  }
  return rawValue >= 1000 ? rawValue / 100 : rawValue;
}

function normalizeAltitudeFtInput(rawValue, label = "Altitude") {
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    throw new Error(`${label} must be > 0 ft`);
  }
  // Treat 3-digit entries as FL shorthand (e.g., 370 -> 37000 ft).
  return rawValue < 1000 ? rawValue * 100 : rawValue;
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

function validateLrcFlightLevelRange(flightLevel, label = "Flight level") {
  const { minFl, maxFl } = getLrcTableFlRange();
  if (!Number.isFinite(minFl) || !Number.isFinite(maxFl)) return;
  if (flightLevel < minFl || flightLevel > maxFl) {
    throw new Error(`${label} out of range (FL${format(minFl, 0)}-FL${format(maxFl, 0)})`);
  }
}

function getGlobalPerfAdjust() {
  const el = document.querySelector("#global-perf-adjust");
  const perfAdjust = parseNum(el?.value);
  if (!Number.isFinite(perfAdjust)) {
    throw new Error("Global flight plan performance adjustment is invalid");
  }
  return perfAdjust;
}

function format(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
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

  let holdFfEng;
  try {
    holdFfEng = lookupHoldMetric(landingWeightT, 1500, "ffEng") * (1 + perfAdjust);
  } catch (error) {
    throw new Error(`Unable to derive FRF from holding table: ${error.message}`);
  }
  const holdFuelHrKg = holdFfEng * 2;
  const frfKg = holdFuelHrKg * 0.5;
  const extraHoldingKg = holdFuelHrKg * (additionalHoldingMin / 60);
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

function shortTripFuelAndAlt(anm, weight, perfAdjust, additionalHoldingMin) {
  if (anm < 50 || anm > 600 || weight < 120 || weight > 200) {
    throw new Error("Short Trip fuel/alt input out of range (ANM 50-600, weight 120-200)");
  }

  const fuelByAnm = interpolateAcrossWeight(shortTripFuelAlt.weightAxis, shortTripFuelAlt.fuelValues, weight);
  const altByAnm = interpolateAcrossWeight(shortTripFuelAlt.weightAxis, shortTripFuelAlt.altitudeValues, weight);

  const fuel1000kg = linear(shortTripFuelAlt.anmAxis, fuelByAnm, anm);
  const altitude = linear(shortTripFuelAlt.anmAxis, altByAnm, anm);
  const timeText = linear(shortTripFuelAlt.anmAxis, shortTripFuelAlt.timeValuesText.map(timeTextToMinutes), anm);

  const flightFuelKg = fuel1000kg * 1000 * (1 + perfAdjust);
  const fuelBuildUp = buildFuelRequirement({
    flightFuelKg,
    landingWeightT: weight,
    additionalHoldingMin,
    perfAdjust,
  });

  return {
    flightFuelKg,
    frfKg: fuelBuildUp.frfKg,
    contingencyKg: fuelBuildUp.contingencyKg,
    extraHoldingKg: fuelBuildUp.extraHoldingKg,
    fixedAllowanceKg: fuelBuildUp.fixedAllowanceKg,
    totalFuelKg: fuelBuildUp.totalFuelKg,
    altitude,
    timeMinutes: timeText,
  };
}

function longRangeAnmFromGnm(gnm, wind) {
  return bilinear(longRangeAnm.gnmAxis, longRangeAnm.windAxis, longRangeAnm.values, gnm, wind);
}

function longRangeFuel(anm, weight, perfAdjust, additionalHoldingMin) {
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
  const flightFuelKg = flightFuel1000KgAdjusted * 1000;
  const fuelBuildUp = buildFuelRequirement({
    flightFuelKg,
    landingWeightT: weight,
    additionalHoldingMin,
    perfAdjust,
  });

  return {
    flightFuel1000Kg: flightFuel1000KgAdjusted,
    frfKg: fuelBuildUp.frfKg,
    contingencyKg: fuelBuildUp.contingencyKg,
    extraHoldingKg: fuelBuildUp.extraHoldingKg,
    fixedAllowanceKg: fuelBuildUp.fixedAllowanceKg,
    totalFuelKg: fuelBuildUp.totalFuelKg,
    timeMinutes,
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
  const evaluateBand = (tableSet) => {
    const anm = Math.abs(wind) < 1e-9
      ? clampToAxis(tableSet.groundToAir.gnmAxis, gnm)
      : bilinearClamped(
          tableSet.groundToAir.gnmAxis,
          tableSet.groundToAir.windAxis,
          tableSet.groundToAir.values,
          gnm,
          wind,
        );

    const referenceFuel1000Kg = bilinearClamped(
      tableSet.fuelTime.anmAxis,
      tableSet.fuelTime.altitudeAxisFt,
      tableSet.fuelTime.fuel1000KgValues,
      anm,
      altitudeFt,
    );
    const timeMinutes = bilinearClamped(
      tableSet.fuelTime.anmAxis,
      tableSet.fuelTime.altitudeAxisFt,
      tableSet.fuelTime.timeMinutesValues,
      anm,
      altitudeFt,
    );
    const adjustment1000Kg = bilinearClamped(
      tableSet.fuelAdjustment.referenceFuelAxis1000Kg,
      tableSet.fuelAdjustment.weightAxisT,
      tableSet.fuelAdjustment.adjustment1000KgValues,
      referenceFuel1000Kg,
      weightT,
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
  const reserveCalcWeightT = weightT - adjustedFuelKg / 1000 - FIXED_ALLOWANCE_KG / 1000;
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

function computeReferenceTurnRadiusNm(tasKt, windSpeedKt) {
  if (!Number.isFinite(tasKt) || tasKt <= 0) {
    throw new Error("TAS must be > 0 kt");
  }
  if (!Number.isFinite(windSpeedKt) || windSpeedKt < 0) {
    throw new Error("Wind speed must be >= 0 kt");
  }
  const referenceGsKt = tasKt + Math.abs(windSpeedKt);
  if (referenceGsKt <= 0) {
    throw new Error("Reference ground speed is invalid");
  }
  const radiusM = (referenceGsKt * KT_TO_MPS) ** 2 / (G0 * Math.tan(toRadians(HOLD_MAX_BANK_DEG)));
  const radiusNm = radiusM / 1852;
  const referenceRateDegPerSec = toDegrees((referenceGsKt / 3600) / radiusNm);
  return {
    referenceGsKt,
    radiusNm,
    referenceRateDegPerSec,
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

  const turnRef = computeReferenceTurnRadiusNm(speed.tasKt, windSpeedKt);
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
    turnModel: "25° bank radius reference",
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
      return `<div class="result-row"><span class="result-key">${k}</span><span class="result-value">${v}</span></div>`;
    })
    .join("");
}

function renderError(target, message) {
  target.innerHTML = `<div class="error">${message}</div>`;
}

function bindShortTrip() {
  const form = document.querySelector("#short-trip-form");
  const out = document.querySelector("#short-trip-out");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const gnm = parseNum(document.querySelector("#st-gnm").value);
      const wind = parseNum(document.querySelector("#st-wind").value);
      const weight = parseNum(document.querySelector("#st-weight").value);
      const perfAdjust = getGlobalPerfAdjust();
      const holdingMin = parseNum(document.querySelector("#st-hold-min").value);

      const anm = shortTripAnmFromGnm(gnm, wind);
      const result = shortTripFuelAndAlt(anm, weight, perfAdjust, holdingMin);

      renderRows(out, [
        ["Air Distance (ANM)", `${format(anm, 0)} nm`],
        ["Flight Fuel", `${format(result.flightFuelKg, 0)} kg`],
        ["FRF (30 min hold @ 1500 ft)", `${format(result.frfKg, 0)} kg`],
        ["Contingency Fuel (5%, min 350, max 1200)", `${format(result.contingencyKg, 0)} kg`],
        [`Additional Holding Fuel (${format(holdingMin, 1)} min)`, `${format(result.extraHoldingKg, 0)} kg`],
        ["Approach Fuel", `${format(result.fixedAllowanceKg, 0)} kg`],
        ["Total Fuel Required", `${format(result.totalFuelKg, 0)} kg`],
        ["Suggested Alt", `${format(result.altitude, 0)} ft`],
        ["Time", formatMinutes(result.timeMinutes)],
      ]);
    } catch (error) {
      renderError(out, error.message);
    }
  });

  form.dispatchEvent(new Event("submit"));
}

function bindLongRange() {
  const form = document.querySelector("#long-range-form");
  const out = document.querySelector("#long-range-out");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const gnm = parseNum(document.querySelector("#lr-gnm").value);
      const wind = parseNum(document.querySelector("#lr-wind").value);
      const weight = parseNum(document.querySelector("#lr-weight").value);
      const perfAdjust = getGlobalPerfAdjust();
      const holdingMin = parseNum(document.querySelector("#lr-hold-min").value);

      const anm = longRangeAnmFromGnm(gnm, wind);
      const result = longRangeFuel(anm, weight, perfAdjust, holdingMin);

      renderRows(out, [
        ["Air Distance (ANM)", `${format(anm, 0)} nm`],
        ["Flight Fuel", `${format(result.flightFuel1000Kg, 3)} x 1000 kg`],
        ["Flight Fuel (kg)", `${format(result.flightFuel1000Kg * 1000, 0)} kg`],
        ["FRF (30 min hold @ 1500 ft)", `${format(result.frfKg, 0)} kg`],
        ["Contingency Fuel (5%, min 350, max 1200)", `${format(result.contingencyKg, 0)} kg`],
        [`Additional Holding Fuel (${format(holdingMin, 1)} min)`, `${format(result.extraHoldingKg, 0)} kg`],
        ["Approach Fuel", `${format(result.fixedAllowanceKg, 0)} kg`],
        ["Total Fuel Required", `${format(result.totalFuelKg, 0)} kg`],
        ["Time", formatMinutes(result.timeMinutes)],
      ]);
    } catch (error) {
      renderError(out, error.message);
    }
  });

  form.dispatchEvent(new Event("submit"));
}

function bindDiversion() {
  const form = document.querySelector("#diversion-form");
  const out = document.querySelector("#diversion-out");
  if (!form || !out) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const gnm = parseNum(document.querySelector("#div-gnm").value);
      const wind = parseNum(document.querySelector("#div-wind").value);
      const altitudeRaw = parseNum(document.querySelector("#div-alt").value);
      const altitudeFt = normalizeAltitudeFtInput(altitudeRaw, "Diversion altitude");
      const weightT = parseNum(document.querySelector("#div-weight").value);
      const holdingMin = parseNum(document.querySelector("#div-hold-min").value);
      const perfAdjust = getGlobalPerfAdjust();
      if (altitudeRaw < 1000) {
        document.querySelector("#div-alt").value = format(altitudeFt, 0);
      }

      const result = diversionLrcFuel(gnm, wind, altitudeFt, weightT, perfAdjust, holdingMin);
      const rows = [
        ["Air Distance (ANM)", `${format(result.anm, 0)} nm`],
        ["Reference Fuel", `${format(result.referenceFuel1000Kg * 1000, 0)} kg`],
        ["Weight Adjustment", `${format(result.adjustment1000Kg * 1000, 0)} kg`],
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
  const timingModeEl = document.querySelector("#hold-timing-mode");
  const totalHoldEl = document.querySelector("#hold-total-min");
  const inboundLegEl = document.querySelector("#hold-inbound-min");
  let lastTotalHoldValue = totalHoldEl.value;
  let lastInboundLegValue = inboundLegEl.value;

  function toggleTimingInputs() {
    const givenTotal = timingModeEl.value === "given-total";
    if (givenTotal) {
      if (!inboundLegEl.disabled && inboundLegEl.value !== "") {
        lastInboundLegValue = inboundLegEl.value;
      }
      inboundLegEl.value = "";
      if (totalHoldEl.value === "" && lastTotalHoldValue !== "") {
        totalHoldEl.value = lastTotalHoldValue;
      }
    } else {
      if (!totalHoldEl.disabled && totalHoldEl.value !== "") {
        lastTotalHoldValue = totalHoldEl.value;
      }
      totalHoldEl.value = "";
      if (inboundLegEl.value === "" && lastInboundLegValue !== "") {
        inboundLegEl.value = lastInboundLegValue;
      }
    }
    totalHoldEl.disabled = !givenTotal;
    inboundLegEl.disabled = givenTotal;
  }

  timingModeEl.addEventListener("change", () => {
    toggleTimingInputs();
    form.dispatchEvent(new Event("submit"));
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const weight = parseNum(document.querySelector("#hold-weight").value);
      const altitudeRaw = parseNum(document.querySelector("#hold-alt").value);
      const altitude = normalizeAltitudeFtInput(altitudeRaw, "Altitude");
      const fuelAvailable = parseNum(document.querySelector("#fuel-available").value);
      const perfAdjust = getGlobalPerfAdjust();
      const timingMode = timingModeEl.value;
      const totalHoldMin = parseNum(totalHoldEl.value);
      const inboundLegMin = parseNum(inboundLegEl.value);
      const holdSide = String(document.querySelector("#hold-side").value || "R").toUpperCase();
      const inboundCourseDeg = parseNum(document.querySelector("#hold-inbound-course").value);
      const windFromDeg = parseNum(document.querySelector("#hold-wind-dir").value);
      const windSpeedKt = parseNum(document.querySelector("#hold-wind-speed").value);
      const timingIasRaw = String(document.querySelector("#hold-timing-ias").value || "").trim();
      const timingIsaDevC = parseNum(document.querySelector("#hold-timing-isa-dev").value);

      if (altitudeRaw < 1000) {
        document.querySelector("#hold-alt").value = format(altitude, 0);
      }

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
      if (!Number.isFinite(timingIsaDevC)) {
        throw new Error("Timing ISA deviation is invalid");
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

  toggleTimingInputs();
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

    try {
      const distanceNm = parseNum(document.querySelector("#lt-distance").value);
      const startWeightT = parseNum(document.querySelector("#lt-weight").value);
      const startFlRaw = parseNum(document.querySelector("#lt-fl").value);
      const startFl = normalizeFlightLevelInput(startFlRaw, "Current flight level");
      const requiredDelayMin = parseNum(document.querySelector("#lt-delay").value);
      const windKt = parseNum(document.querySelector("#lt-wind").value);
      const perfAdjust = getGlobalPerfAdjust();
      const levelChangeMode = levelModeEl.value;
      const newFlRaw = parseNum(newFlEl.value);
      const newFl =
        levelChangeMode === "none" ? startFl : normalizeFlightLevelInput(newFlRaw, "New flight level");
      validateLrcFlightLevelRange(startFl, "Current flight level");
      if (levelChangeMode !== "none") {
        validateLrcFlightLevelRange(newFl, "New flight level");
      }

      if (startFlRaw >= 1000) {
        document.querySelector("#lt-fl").value = format(startFl, 0);
      }
      if (levelChangeMode !== "none" && newFlRaw >= 1000) {
        newFlEl.value = format(newFl, 0);
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
            ["Option C Time to Fix (target)", formatMinutes(comparison.targetFixTime)],
            [
              "Option C Required IAS / Mach",
              `${format(comparison.optionC.requiredIasKt, 0)} kt / ${format(comparison.optionC.requiredMach, 3)}`,
            ],
          ]
        : [["Option C", comparison.optionCError || "Unable to compute required speed"]];

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
  const tempModeEl = document.querySelector("#conv-temp-mode");
  const oatEl = document.querySelector("#conv-oat");
  const isaDevEl = document.querySelector("#conv-isa-dev");

  function toggleInputs() {
    const mode = modeEl.value;
    iasEl.disabled = mode !== "ias";
    machEl.disabled = mode !== "mach";
    tasEl.disabled = mode !== "tas";

    flEl.disabled = false;

    const tempMode = tempModeEl.value;
    oatEl.disabled = tempMode !== "oat";
    isaDevEl.disabled = tempMode !== "isa-dev";
  }

  modeEl.addEventListener("change", () => {
    toggleInputs();
    form.dispatchEvent(new Event("submit"));
  });
  tempModeEl.addEventListener("change", () => {
    toggleInputs();
    form.dispatchEvent(new Event("submit"));
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const tempMode = tempModeEl.value;
      const flRaw = parseNum(flEl.value);
      const fl = normalizeFlightLevelInput(flRaw, "Flight level");
      const oatC = parseNum(oatEl.value);
      const isaDeviationC = parseNum(isaDevEl.value);
      const mode = modeEl.value;

      if (flRaw >= 1000) {
        flEl.value = format(fl, 0);
      }
      const pressureAltitudeFt = fl * 100;
      const atmosphere = atmosphereFromPressureAltitude({
        pressureAltitudeFt,
        tempMode,
        oatC,
        isaDeviationC,
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
  form.dispatchEvent(new Event("submit"));
}

function bindGlobalSettings() {
  const globalPerfEl = document.querySelector("#global-perf-adjust");
  if (!globalPerfEl) return;

  const refreshAll = () => {
    [
      "#short-trip-form",
      "#long-range-form",
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

bindShortTrip();
bindLongRange();
bindDiversion();
bindHolding();
bindLoseTime();
bindConversion();
bindGlobalSettings();
registerServiceWorker();
