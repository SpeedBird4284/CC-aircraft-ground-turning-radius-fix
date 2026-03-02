// ==UserScript==
// @name         CC aircraft ground physics fix
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  This addon fixes the turning radius of several CC aircraft.
// @author       SpeedBird
// @match        https://www.geo-fs.com/geofs.php?v=3.9
// @match        https://www.geo-fs.com/geofs.php
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // GeoFS Airbus A320-232 (by Spice_9) ground handling tweaks
  // Tight low-speed turning, higher grip, and reduced ground tipping.

  const ALLOWED_AIRCRAFT_IDS = new Set([
    3011, // A320-232 (Spice_9)
    3179, // B787-10 (British Airways)
    2769, // B737 MAX 8 (TUI)
    2843, // A220-300 (Air Tanzania)
    2899, // A220-300 (Swiss)
    5156, // A318-112 by Luca &
    2879, // A319 (Finnair)
    5847, // A319neo by Spice9 &
    3534, // A320-214 (Easyjet)
    2871, // A320neo (Iberia)
    5086, // A321-211
    4646, // A321neo (Spice9)
    2856, // A330-200
    4631, // A330-900neo (Virgin Atlantic)
    2951, // A340-300
    5203, // B737-600 by Luca &
    3054, // B737-800 (Spice9)
    4743, // B757-300
    4745, // B757-300wl
    4764, // B767-400
    3180, // B787-10 Dreamliner (Etihad)
    3575, // B787-9 (Spice9)
    5073, // Bombardier Learjet 45 XR
    3036, // Embraer E195-E2
    4017  // Embraer ERJ145LR (by Spice9) &
  ]);
  const REFERENCE_WHEELBASE_M = 11.0; // Approx A320-232 nose-to-main distance used as baseline
  const INSTALL_CHECK_INTERVAL_MS = 1000;

  function analyzeGroundGeometry(instance) {
    const wheels = Array.isArray(instance.wheels) ? instance.wheels : [];
    const suspensions = Array.isArray(instance.suspensions) ? instance.suspensions : [];
    const collisionPoints = Array.isArray(instance.collisionPoints) ? instance.collisionPoints : [];
    const rigidBody = instance.rigidBody || {};

    const noseWheel = wheels.find((w) => (w.isNoseWheel || '') || ((w.name || '').toLowerCase().includes('nose')));
    const mains = wheels.filter((w) => w !== noseWheel);

    let wheelbase = null;
    if (noseWheel && mains.length && noseWheel.position && Array.isArray(noseWheel.position)) {
      const avgMainZ = mains.reduce((sum, w) => sum + ((w.position && Array.isArray(w.position)) ? w.position[2] : 0), 0) / mains.length;
      wheelbase = Math.abs(noseWheel.position[2] - avgMainZ);
    }

    let maxSteeringAngle = null;
    let steeringSign = 1;
    if (noseWheel) {
      maxSteeringAngle =
        noseWheel.maxSteeringAngle ||
        (noseWheel.steering && noseWheel.steering.max) ||
        noseWheel.maxSteer ||
        noseWheel.steering;

      // Try to infer steering direction; default is +1.
      const steerVal =
        (typeof noseWheel.steering === 'number' ? noseWheel.steering : null) ||
        (typeof noseWheel.maxSteeringAngle === 'number' ? noseWheel.maxSteeringAngle : null) ||
        (noseWheel.steering && typeof noseWheel.steering.min === 'number' ? noseWheel.steering.min : null);
      if (typeof steerVal === 'number' && steerVal < 0) {
        steeringSign = -1;
      }
      if (typeof noseWheel.steeringSign === 'number' && (noseWheel.steeringSign === -1 || noseWheel.steeringSign === 1)) {
        steeringSign = noseWheel.steeringSign;
      }
    }

    return {
      wheelbase,
      maxSteeringAngle,
      steeringSign,
      boundingSphereRadius: instance.boundingSphereRadius,
      mass: rigidBody.mass,
      inertia: rigidBody.inertia,
      wheelsCount: wheels.length,
      suspensionsCount: suspensions.length,
      collisionPointsCount: collisionPoints.length
    };
  }

  function buildYawTuning(aircraftId, geometry) {
    const base = {
      factorStationary: 1.3,
      factorMax: 9.0,
      maxStationary: 1.0,
      maxMoving: 2.4,
      easing: {
        stationary: 0.2,
        low: 0.25,
        mid: 0.28,
        ramp: 0.3,
        high: 0.35
      }
    };

    // Preserve the known-good baseline for the A320-232 exactly as before.
    if (aircraftId === 3011) {
      return base;
    }

    // Geometry-aware scaling: longer wheelbase or limited steering requires more input boost.
    let geometryScale = 1.0;
    if (geometry && geometry.wheelbase) {
      const wheelbaseScale = geometry.wheelbase / REFERENCE_WHEELBASE_M;
      geometryScale = Math.max(0.9, Math.min(1.8, wheelbaseScale));
    }

    // Gentle bump if steering throw is low
    if (geometry && geometry.maxSteeringAngle && geometry.maxSteeringAngle < 50) {
      geometryScale *= 1.1;
    }

    // Specific tuning for 787-10: bias toward tighter radius while keeping damping similar.
    if (aircraftId === 3179) {
      geometryScale = Math.min(1.9, geometryScale * 1.15);
    }

    // Specific tuning for 737 MAX 8: modest bias toward tight turns (shorter wheelbase than 787).
    if (aircraftId === 2769) {
      geometryScale = Math.min(1.6, geometryScale * 1.1);
    }

    const tuning = {
      factorStationary: base.factorStationary * geometryScale,
      factorMax: base.factorMax * Math.min(1.6, geometryScale * 1.35),
      maxStationary: base.maxStationary,
      maxMoving: base.maxMoving * Math.min(1.5, geometryScale * 1.25),
      easing: base.easing
    };

    // Widebody softening: slightly reduce yaw authority for A330-200/900 and A340-300
    const widebodySoftIds = new Set([
      2856, // A330-200
      4631, // A330-900neo (Virgin Atlantic)
      2951  // A340-300
    ]);

    if (widebodySoftIds.has(aircraftId)) {
      // Pull factors a bit closer to baseline to widen radius slightly
      tuning.factorStationary = Math.min(tuning.factorStationary, 1.0);
      tuning.factorMax = Math.min(tuning.factorMax, 11.0);
      tuning.maxMoving = Math.min(tuning.maxMoving, 2.1);
    }

    // Narrowbody softening: slightly widen radius only for selected 737s.
    const narrowbodySoftIds = new Set([
      2769, // B737 MAX 8 (TUI)
      5203, // B737-600 by Luca &
      3054  // B737-800 (Spice9)
    ]);

    if (narrowbodySoftIds.has(aircraftId)) {
      // Reduce yaw authority by ~20% total to slightly widen turn radius further.
      tuning.factorStationary *= 0.8;
      tuning.factorMax *= 0.8;
      tuning.maxMoving *= 0.8;
    }

    // Slightly tighter ground steering for selected A320-family variants only.
    const a320TightYawIds = new Set([
      3534, // A320-214 (Easyjet)
      2871, // A320neo (Iberia)
      5086, // A321-211
      4646  // A321neo (Spice9)
    ]);

    if (a320TightYawIds.has(aircraftId)) {
      // Small increase in yaw authority to gently tighten turn radius.
      tuning.factorStationary *= 1.08;
      tuning.factorMax *= 1.08;
      tuning.maxMoving *= 1.08;
    }

    return tuning;
  }

  function buildAttitudeTuning(aircraftId) {
    const base = {
      // Roll scales and clamps (match current defaults)
      rollLowSpeedScale1: 0.05,
      rollLowSpeedScale2: 0.03,
      rollTaxiScale: 0.3,
      rollClampLow: 0.05,
      rollClampTaxi: 0.4,
      // Pitch scales and clamp (match current defaults)
      pitchKiasMax: 35,
      pitchScale1: 0.05,
      pitchScale2: 0.08,
      pitchScale3: 0.15,
      pitchClamp: 0.08,
      pitchBias: 0.0
    };

    if (!aircraftId) {
      return base;
    }

    // Widebody damping: strong but not extreme.
    const widebodyDampedIds = new Set([
      2951, // A340-300
      2856, // A330-200
      4631  // A330-900neo (Virgin Atlantic)
    ]);

    if (widebodyDampedIds.has(aircraftId)) {
      return {
        ...base,
        // Roll: very small response and tight clamps
        rollLowSpeedScale1: 0.002,
        rollLowSpeedScale2: 0.002,
        rollTaxiScale: 0.04,
        rollClampLow: 0.006,
        rollClampTaxi: 0.04,
        // Pitch: strongly limit nose lean while taxiing
        pitchScale1: 0.008,
        pitchScale2: 0.015,
        pitchScale3: 0.03,
        pitchClamp: 0.02,
        pitchBias: 0.0
      };
    }

    // A320 family damping (A319neo/A320/A321 variants): eliminate ground tilt and nose dip with fixed nose-up bias.
    const a320FamilyIds = new Set([
      5847, // A319neo by Spice9 &
      3534, // A320-214 (Easyjet)
      2871, // A320neo (Iberia)
      5086, // A321-211
      4646  // A321neo (Spice9)
    ]);

    if (a320FamilyIds.has(aircraftId)) {
      return {
        ...base,
        // Extend pitch control to higher taxi speeds on ground
        pitchKiasMax: 80,
        // Roll: lock to zero on ground (no visible banking in taxi turns)
        rollLowSpeedScale1: 0.0,
        rollLowSpeedScale2: 0.0,
        rollTaxiScale: 0.0,
        rollClampLow: 0.0,
        rollClampTaxi: 0.0,
        // Pitch: hold a small positive nose-up attitude on ground
        pitchScale1: 0.0,
        pitchScale2: 0.0,
        pitchScale3: 0.0,
        pitchClamp: 0.0,
        pitchBias: 0.02
      };
    }

    // 737 damping: even flatter, to minimize tilt for MAX/600/800.
    const strong737Ids = new Set([
      2769, // B737 MAX 8 (TUI)
      3054, // B737-800 (Spice9)
      5203  // B737-600 by Luca &
    ]);

    if (strong737Ids.has(aircraftId)) {
      return {
        ...base,
        // Roll: near-locked on ground, very small allowed bank
        rollLowSpeedScale1: 0.0008,
        rollLowSpeedScale2: 0.0008,
        rollTaxiScale: 0.02,
        rollClampLow: 0.003,
        rollClampTaxi: 0.02,
        // Pitch: heavily limited nose motion with slight nose-up bias
        pitchScale1: 0.004,
        pitchScale2: 0.008,
        pitchScale3: 0.016,
        pitchClamp: 0.012,
        pitchBias: 0.012
      };
    }

    return base;
  }

  function canInstallForCurrentAircraft() {
    if (!window.geofs || !geofs.aircraft || !geofs.aircraft.instance) {
      return false;
    }

    const instance = geofs.aircraft.instance;

    // If GeoFS exposes an aircraft id, only apply to allowed IDs.
    // If not present, we simply skip this check and allow installation.
    if (typeof instance.id !== 'undefined') {
      const idNum = Number(instance.id);
      if (!Number.isNaN(idNum) && !ALLOWED_AIRCRAFT_IDS.has(idNum)) {
        return false;
      }
    }

    return !!(instance.definition && geofs.animation && geofs.animation.values);
  }

  function installA320GroundHandling() {
    if (!canInstallForCurrentAircraft()) {
      return false;
    }

    const instance = geofs.aircraft.instance;
    const aircraftId = Number(instance.id) || null;
    const def = instance.definition;
    const geometry = analyzeGroundGeometry(instance);
    const yawTune = buildYawTuning(aircraftId, geometry);
    const attitudeTune = buildAttitudeTuning(aircraftId);

    // Prevent double-installing for the same aircraft id; allow re-install when the aircraft changes.
    if (window.__a320GroundHandlingInstalledForId === aircraftId) {
      return true;
    }

    console.log('[A320 Ground Handling] Geometry:', geometry, 'Yaw tuning:', yawTune, 'Attitude tuning:', attitudeTune);

    // 1) High grip + extra damping in the gear contact (to reduce sliding and bounce)
    if (def.contactProperties && def.contactProperties.wheel) {
      const wheel = def.contactProperties.wheel;
      wheel.frictionCoef = 11.0;
      wheel.dynamicFriction = 0.06;
      wheel.rollingFriction = 0.00016;
      wheel.damping = 3.6;
      console.log('[A320 Ground Handling] Wheel contact updated:', wheel);
    } else {
      console.warn('[A320 Ground Handling] No wheel contactProperties found');
    }

    // 2) YAW hook: sharp low-speed turns, with speed-dependent softening
    (function hookYaw() {
      const v = geofs.animation.values;

      const FACTOR_STATIONARY = yawTune.factorStationary;
      const FACTOR_MAX = yawTune.factorMax; // slightly stronger for tighter radius
      const MAX_STATIONARY = yawTune.maxStationary;
      const MAX_MOVING = yawTune.maxMoving; // allow a bit more nosewheel angle at low speed
      const STEERING_SIGN = geometry.steeringSign || 1;

      let rawYaw = v.yaw || 0;
      let smoothYaw = rawYaw;

      Object.defineProperty(v, 'yaw', {
        configurable: true,
        enumerable: true,
        get: function () {
          const vals = geofs.animation.values || v;
          const onGround = !!vals.groundContact;
          const kias = vals.kias || 0;

          if (onGround && kias < 80) {
            let factor;
            let maxDeflection;
            let alpha;

            if (kias < 1) {
              factor = FACTOR_STATIONARY;
              maxDeflection = MAX_STATIONARY;
              alpha = yawTune.easing.stationary;
            } else if (kias < 5) {
              const t = (kias - 1) / (5 - 1);
              factor = FACTOR_STATIONARY + (FACTOR_MAX - FACTOR_STATIONARY) * t;
              maxDeflection = MAX_STATIONARY + (MAX_MOVING - MAX_STATIONARY) * t;
              alpha = yawTune.easing.low;
            } else if (kias < 10) {
              factor = FACTOR_MAX;
              maxDeflection = MAX_MOVING;
              alpha = yawTune.easing.mid;
            } else if (kias < 20) {
              const t = (kias - 10) / 10; // 0..1
              const factorHigh = FACTOR_MAX; // 7.5 at 10 kts
              const factorLow = 4.2;
              factor = factorHigh + (factorLow - factorHigh) * t;

              const maxHigh = MAX_MOVING; // 2.2 at 10 kts
              const maxLow = 1.8;
              maxDeflection = maxHigh + (maxLow - maxHigh) * t;
              alpha = yawTune.easing.ramp;
            } else {
              if (kias < 30) {
                const t = (kias - 20) / 10; // 0..1
                factor = 4.2 + (1 - 4.2) * t; // 4.2 -> 1
                maxDeflection = 1.8 + (1.0 - 1.8) * t;
              } else {
                factor = 1.0;
                maxDeflection = 1.0;
              }
              alpha = yawTune.easing.high;
            }

            let target = rawYaw * factor * STEERING_SIGN;

            if (target > maxDeflection) target = maxDeflection;
            if (target < -maxDeflection) target = -maxDeflection;

            smoothYaw = smoothYaw + (target - smoothYaw) * alpha;
            return smoothYaw;
          }

          smoothYaw = rawYaw;
          return rawYaw;
        },
        set: function (val) {
          rawYaw = val;
        }
      });
    })();

    // 3) ROLL hook: clamp roll on the ground at taxi speeds to avoid tipping
    (function hookRoll() {
      const v = geofs.animation.values;

      let rawRoll = v.roll || 0;

      const R1_SCALE = attitudeTune.rollLowSpeedScale1;
      const R2_SCALE = attitudeTune.rollLowSpeedScale2;
      const R3_SCALE = attitudeTune.rollTaxiScale;
      const R_CLAMP_LOW = attitudeTune.rollClampLow;
      const R_CLAMP_TAXI = attitudeTune.rollClampTaxi;

      Object.defineProperty(v, 'roll', {
        configurable: true,
        enumerable: true,
        get: function () {
          const vals = geofs.animation.values || v;
          const onGround = !!vals.groundContact;
          const kias = vals.kias || 0;

          if (onGround) {
            let out = rawRoll;

            if (kias < 1) {
              out = rawRoll * R1_SCALE;
              if (out > R_CLAMP_LOW) out = R_CLAMP_LOW;
              if (out < -R_CLAMP_LOW) out = -R_CLAMP_LOW;
              return out;
            }

            if (kias < 15) {
              out = rawRoll * R2_SCALE;
              if (out > R_CLAMP_LOW) out = R_CLAMP_LOW;
              if (out < -R_CLAMP_LOW) out = -R_CLAMP_LOW;
              return out;
            }

            if (kias < 60) {
              out = rawRoll * R3_SCALE;
              if (out > R_CLAMP_TAXI) out = R_CLAMP_TAXI;
              if (out < -R_CLAMP_TAXI) out = -R_CLAMP_TAXI;
              return out;
            }
          }

          return rawRoll;
        },
        set: function (val) {
          rawRoll = val;
        }
      });
    })();

    // 4) PITCH hook: clamp nose pitch on the ground at taxi speeds to limit nose-gear dipping
    (function hookPitch() {
      const v = geofs.animation.values;

      let rawPitch = v.pitch || 0;

      const P_KIAS_MAX = attitudeTune.pitchKiasMax;
      const P1 = attitudeTune.pitchScale1;
      const P2 = attitudeTune.pitchScale2;
      const P3 = attitudeTune.pitchScale3;
      const P_CLAMP = attitudeTune.pitchClamp;
      const P_BIAS = attitudeTune.pitchBias || 0;

      Object.defineProperty(v, 'pitch', {
        configurable: true,
        enumerable: true,
        get: function () {
          const vals = geofs.animation.values || v;
          const onGround = !!vals.groundContact;
          const kias = vals.kias || 0;

          if (onGround && kias < P_KIAS_MAX) {
            let out = rawPitch;

            if (kias < 1) {
              out = rawPitch * P1;
            } else if (kias < 15) {
              out = rawPitch * P2;
            } else {
              out = rawPitch * P3; // a bit more freedom 15–35 kts
            }

            if (out > P_CLAMP) out = P_CLAMP;
            if (out < -P_CLAMP) out = -P_CLAMP;

            // Apply small ground-only nose-up bias for aircraft that specify it (e.g. 737s).
            out += P_BIAS;

            return out;
          }

          return rawPitch;
        },
        set: function (val) {
          rawPitch = val;
        }
      });
    })();

    return true;
  }

  // Periodically check if GeoFS and the target aircraft are ready; allow re-install on aircraft changes.
  let lastInstalledId = null;
  const installerInterval = setInterval(function () {
    try {
      if (!window.geofs || !geofs.aircraft || !geofs.aircraft.instance) {
        return;
      }

      const currentId = Number(geofs.aircraft.instance.id) || null;
      if (currentId !== lastInstalledId) {
        if (installA320GroundHandling()) {
          window.__a320GroundHandlingInstalledForId = currentId;
          lastInstalledId = currentId;
          console.log('[A320 Ground Handling] Installed for aircraft id', currentId);
        }
      }
    } catch (e) {
      console.error('[A320 Ground Handling] Error during installation:', e);
    }
  }, INSTALL_CHECK_INTERVAL_MS);
})();
