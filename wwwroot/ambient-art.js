(function (root) {
  'use strict';

  const defaultPalette = ['#ff3131','#ff8a00','#ffd60a','#25d366','#1687ff','#3f37c9','#a855f7','#ff2d9a'];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const mod = (value, length) => ((value % length) + length) % length;

  function hexToRgb(hex) {
    const value = parseInt(String(hex).replace('#', ''), 16);
    return { r:(value >> 16) & 255, g:(value >> 8) & 255, b:value & 255 };
  }

  function rgbToHex(rgb) {
    return '#' + ['r','g','b'].map(key => Math.round(clamp(rgb[key], 0, 255)).toString(16).padStart(2, '0')).join('');
  }

  function paletteColor(palette, position) {
    const safe = palette?.length ? palette : defaultPalette;
    const value = mod(position, safe.length), left = Math.floor(value), mix = value - left;
    const a = hexToRgb(safe[left]), b = hexToRgb(safe[(left + 1) % safe.length]);
    return rgbToHex({ r:a.r + (b.r - a.r) * mix, g:a.g + (b.g - a.g) * mix, b:a.b + (b.b - a.b) * mix });
  }

  function travelAt(elapsedSec, cycleSec, direction) {
    const progress = mod(Math.max(0, Number(elapsedSec) || 0) / clamp(cycleSec, 2, 60), 1);
    if (direction === 'reverse') return -progress;
    if (direction === 'pingpong') return .5 - Math.cos(progress * Math.PI * 2) * .5;
    return progress;
  }

  function buildFrame(options = {}) {
    const bridges = (options.bridges || []).map(bridge => ({
      bridgeIndex:Number(bridge.bridgeIndex), lightIds:(bridge.lightIds || []).map(String)
    })).filter(bridge => bridge.lightIds.length);
    const palette = options.palette?.length ? options.palette : defaultPalette;
    const minBrightness = clamp(options.minBrightness ?? 18, 1, 100);
    const maxBrightness = Math.max(minBrightness, clamp(options.maxBrightness ?? 78, 1, 100));
    const effect = ['rainbow','brightness','color'].includes(options.effect) ? options.effect : 'rainbow';
    const syncMode = ['same','mirror','continuous'].includes(options.syncMode) ? options.syncMode : 'mirror';
    const travel = travelAt(options.elapsedSec, options.cycleSec ?? 14, options.direction);
    const total = bridges.reduce((sum, bridge) => sum + bridge.lightIds.length, 0);
    let globalOffset = 0;
    const lights = [];

    bridges.forEach((bridge, bridgePosition) => {
      const count = bridge.lightIds.length;
      bridge.lightIds.forEach((id, index) => {
        let position;
        if (syncMode === 'continuous' && total > 0) position = (globalOffset + index) / total;
        else if (syncMode === 'mirror' && bridgePosition % 2 === 1) position = (count - 1 - index) / Math.max(1, count);
        else position = index / Math.max(1, count);

        const wave = .5 + Math.cos((position - travel) * Math.PI * 2) * .5;
        const shapedWave = Math.pow(clamp(wave, 0, 1), .72);
        const breath = .62 + Math.sin(travel * Math.PI * 2) * .18;
        const brightnessRatio = effect === 'color' ? clamp(breath, 0, 1) : shapedWave;
        const brightness = minBrightness + (maxBrightness - minBrightness) * brightnessRatio;
        const colorTravel = options.colorMove === false || effect === 'brightness' ? 0 : travel * palette.length;
        const color = paletteColor(palette, position * palette.length - colorTravel);
        lights.push({ bridgeIndex:bridge.bridgeIndex, id, color, brightness:Number(brightness.toFixed(2)) });
      });
      globalOffset += count;
    });

    return { lights, travel, effect, syncMode };
  }

  const api = { defaultPalette, paletteColor, travelAt, buildFrame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HueAmbientArt = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
