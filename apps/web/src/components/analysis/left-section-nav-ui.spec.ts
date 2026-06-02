import assert from 'node:assert/strict';
import {
  NAV_ACTIVE_RAIL_CLASS,
  NAV_ITEM_BASE_CLASS,
  NAV_MARKER_BASE_CLASS,
  getNavStatusMarker,
} from './left-section-nav-ui';

assert.deepEqual(getNavStatusMarker('completed'), {
  label: '●',
  className: 'text-[var(--color-accent)]',
});

assert.deepEqual(getNavStatusMarker('skipped'), {
  label: '—',
  className: 'text-[var(--color-warn)]',
});

assert.deepEqual(getNavStatusMarker('pending'), {
  label: '○',
  className: 'text-[var(--color-fg-4)]',
});

assert.match(NAV_ITEM_BASE_CLASS, /text-\[15px\]/);
assert.match(NAV_ITEM_BASE_CLASS, /py-2\.5/);
assert.match(NAV_MARKER_BASE_CLASS, /text-\[14px\]/);
assert.match(NAV_ACTIVE_RAIL_CLASS, /h-\[34px\]/);

console.log('left-section-nav-ui assertions passed');
