# Lucide icon subset

`lucide-subset.js` holds only the icons VTrade's pages use, taken from the `lucide` npm package 1.31.0 (ISC, see `LICENSE`). It exposes `window.lucide` with `icons` and `createElement`, which is what VCPChat's `lucide-adapter.js` (in `../vcp-ui/`) needs to turn VCPUI icon names into SVGs.

To add an icon, put its name in `ICONS` in `build-subset.cjs` and regenerate:

```sh
node build-subset.cjs <path to the lucide package> ../vcp-ui/lucide-adapter.js
```
