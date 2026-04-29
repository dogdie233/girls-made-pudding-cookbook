// app.js — Girls Pudding Cookbook
// Loads recipes/i18n, tracks inventory + made-recipes, handles save-file import, renders polaroid cards.

const STORAGE_KEY = 'gpc.state.v1';
const STORAGE_SETTINGS = 'gpc.settings.v1';

const state = {
  lang: 'jp',
  recipes: [],
  foods: [],
  tools: [],
  i18n: {},
  // runtime
  inventory: Object.create(null), // foodId → count
  made: new Set(), // cookingId
};

// DOM caches for diff-based updates (so we don't replay enter animations on every toggle)
const cardNodes = new Map(); // recipeId → <article>
const invNodes = new Map();  // foodId → <li>

// ---------------- utilities ----------------
function t(key) {
  return state.i18n[state.lang]?.ui?.[key] ?? key;
}
function foodName(id) {
  return state.i18n[state.lang]?.food?.[id] ?? id;
}
function cookingName(id) {
  return state.i18n[state.lang]?.cooking?.[id] ?? id;
}
function toolName(id) {
  return state.i18n[state.lang]?.tool?.[id] ?? id;
}
function categoryName(cat) {
  return state.i18n[state.lang]?.category?.[cat] ?? cat;
}

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function showToast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1600);
}

// Tween a numeric badge from its previously-rendered value to the new one using
// requestAnimationFrame. Duration is short and ease-out so it feels like a quick
// digit flip rather than a slow counter.
function tweenBadge(el, from, to, durationMs = 240) {
  // Cancel any in-flight tween on this element so rapid clicks always land correctly.
  cancelBadgeTween(el);
  if (from === to) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    // easeOutQuad
    const eased = 1 - (1 - t) * (1 - t);
    const v = Math.round(from + (to - from) * eased);
    el.textContent = String(v);
    if (t < 1) {
      el._tween = requestAnimationFrame(step);
    } else {
      el._tween = 0;
    }
  };
  el._tween = requestAnimationFrame(step);
}

function cancelBadgeTween(el) {
  if (el._tween) {
    cancelAnimationFrame(el._tween);
    el._tween = 0;
  }
}

// Map a BCP-47 navigator tag ("en-US", "zh-Hans-CN", "ja-JP") to our codes.
function detectBrowserLang() {
  const candidates = [
    ...(navigator.languages || []),
    navigator.language || '',
  ].filter(Boolean);
  for (const raw of candidates) {
    const tag = raw.toLowerCase();
    if (tag.startsWith('ja')) return 'jp';
    if (tag.startsWith('en')) return 'en';
    if (tag.startsWith('zh')) {
      if (tag.includes('tw') || tag.includes('hk') || tag.includes('mo') || tag.includes('hant'))
        return 'zhtw';
      return 'zhcn';
    }
  }
  return 'jp';
}

// ---------------- persistence ----------------
function saveLocal() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ inventory: state.inventory, made: [...state.made] })
    );
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify({ lang: state.lang }));
  } catch {}
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.inventory && typeof s.inventory === 'object') state.inventory = s.inventory;
      if (Array.isArray(s.made)) state.made = new Set(s.made);
    }
    const s2 = JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || '{}');
    if (s2.lang && state.i18n[s2.lang]) state.lang = s2.lang;
  } catch {}
}

// ---------------- cookability ----------------
function buildFoodsByCategory() {
  const map = Object.create(null);
  for (const f of state.foods) (map[f.category] = map[f.category] || []).push(f.id);
  return map;
}

function expandSlotCandidates(slot, foodsByCat) {
  if (!slot.startsWith('<')) return [slot];
  const tags = slot.split('|').map((s) => s.replace(/[<>]/g, '').trim());
  const out = new Set();
  for (const tag of tags) {
    if (tag === 'any') for (const f of state.foods) out.add(f.id);
    else for (const fid of (foodsByCat[tag] || [])) out.add(fid);
  }
  return [...out];
}

function canCook(recipe, inventory, foodsByCat) {
  return countMissingSlots(recipe, inventory, foodsByCat) === 0;
}

// Compute the minimum number of slots that can't be satisfied by the current inventory.
// Returns 0 iff the recipe is cookable; bigger = farther off.
// Implemented as a thin wrapper over computeSlotFill so all three — canCook,
// countMissingSlots, and the per-slot highlight — agree by construction.
function countMissingSlots(recipe, inventory, foodsByCat) {
  const assignment = computeSlotFill(recipe, inventory, foodsByCat);
  let missing = 0;
  for (const v of assignment) if (v === null || v === undefined) missing++;
  return missing;
}

// Compute which ingredient slots can actually be filled given finite inventory.
// Uses the same backtracking as countMissingSlots but records the best
// assignment so the UI doesn't double-count units (e.g. needing two flour but
// owning one should light up one slot, not both).
function computeSlotFill(recipe, inventory, foodsByCat) {
  const n = recipe.ingredients.length;
  // Map each original slot index to its candidate food-id list.
  const candidates = recipe.ingredients.map((slot) => expandSlotCandidates(slot, foodsByCat));
  // Visit most-restrictive slots first for better pruning.
  const order = candidates.map((_, i) => i).sort((a, b) => candidates[a].length - candidates[b].length);

  const pool = { ...inventory };
  let bestFilled = -1;
  let bestAssign = null; // array of fid-or-null indexed by ORIGINAL slot index
  const current = new Array(n).fill(null);

  function bt(k, filled, remaining) {
    // Upper-bound pruning: even if we fill every remaining slot, can we beat best?
    if (filled + remaining <= bestFilled) return;
    if (k === order.length) {
      if (filled > bestFilled) {
        bestFilled = filled;
        bestAssign = current.slice();
      }
      return;
    }
    const slotIdx = order[k];
    // Try to fill this slot with each candidate
    for (const fid of candidates[slotIdx]) {
      if ((pool[fid] || 0) > 0) {
        pool[fid]--;
        current[slotIdx] = fid;
        bt(k + 1, filled + 1, remaining - 1);
        pool[fid]++;
        current[slotIdx] = null;
        if (bestFilled === n) return; // perfect match; stop early
      }
    }
    // Or skip (leave this slot unfilled)
    current[slotIdx] = null;
    bt(k + 1, filled, remaining - 1);
  }
  bt(0, 0, n);
  return bestAssign ?? new Array(n).fill(null);
}

// ---------------- save file import ----------------
function importSaveText(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { showToast('JSON parse error: ' + e.message); return false; }
  const pairs = Array.isArray(parsed?.Pairs) ? parsed.Pairs : null;
  if (!pairs) { showToast('Unrecognized save format'); return false; }
  let opened = null, invItems = null;
  for (const p of pairs) {
    if (p.Key === 'app.CookingSystem+Saveable') {
      try { opened = JSON.parse(p.Value).Opened || []; } catch {}
    } else if (p.Key === 'app.Inventory+Saveable') {
      try { invItems = JSON.parse(p.Value).Items || []; } catch {}
    }
  }
  if (opened) state.made = new Set(opened.filter((id) => id.startsWith('cooking')));
  if (invItems) {
    state.inventory = Object.create(null);
    for (const id of invItems) {
      if (id.startsWith('food')) state.inventory[id] = (state.inventory[id] || 0) + 1;
    }
  }
  saveLocal();
  showToast(`✓ ${state.made.size} recipes, ${Object.values(state.inventory).reduce((a, b) => a + b, 0)} items`);
  $('#clear-save').hidden = false;
  renderAll();
  return true;
}

// ---------------- static UI text ----------------
function applyLang() {
  document.documentElement.lang =
    state.lang === 'jp' ? 'ja' : state.lang === 'en' ? 'en' : state.lang === 'zhcn' ? 'zh-CN' : 'zh-TW';
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  // Update custom select's "current" label to match state.lang.
  $('#lang-select')?._repaint?.();
}

function updateStats() {
  const total = state.recipes.length;
  const done = state.recipes.filter((r) => state.made.has(r.id)).length;
  const fmt = t('statsLabel') || '{done} / {total}';
  $('#stats').textContent = fmt.replace('{done}', done).replace('{total}', total);
}

// ---------------- inventory (diff-based) ----------------
function renderInventory() {
  const list = $('#inventory-list');
  const foodsByCat = buildFoodsByCategory();
  const notMade = state.recipes.filter((r) => !state.made.has(r.id));
  const neededFoods = new Set();
  for (const r of notMade) {
    for (const slot of r.ingredients) {
      for (const fid of expandSlotCandidates(slot, foodsByCat)) neededFoods.add(fid);
    }
  }

  // Build-once; on rerender only mutate
  for (const food of state.foods) {
    let li = invNodes.get(food.id);
    let firstMount = false;
    if (!li) {
      li = document.createElement('li');
      li.className = 'inv-item';
      firstMount = true;

      const img = document.createElement('img');
      img.src = `assets/ingredients/${food.id}.png`;
      li.appendChild(img);

      const badge = document.createElement('span');
      badge.className = 'badge';
      li.appendChild(badge);

      const tip = document.createElement('span');
      tip.className = 'name-tip';
      li.appendChild(tip);

      li.addEventListener('click', () => {
        state.inventory[food.id] = (state.inventory[food.id] || 0) + 1;
        saveLocal();
        onInventoryChange();
      });
      li.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const c = state.inventory[food.id] || 0;
        if (c <= 0) return;
        if (c === 1) delete state.inventory[food.id];
        else state.inventory[food.id] = c - 1;
        saveLocal();
        onInventoryChange();
      });

      invNodes.set(food.id, li);
      list.appendChild(li);
    }

    const count = state.inventory[food.id] || 0;
    const prevCount = firstMount ? count : Number(li.dataset.count || 0);
    li.dataset.count = count;

    const badge = li.querySelector('.badge');
    // Toggle visibility with a CSS transition instead of display:none so the
    // count can gracefully fade/scale in and out on 0 ↔ N transitions.
    badge.classList.toggle('visible', count > 0);
    if (count > 0) {
      tweenBadge(badge, prevCount, count);
      if (prevCount !== count && prevCount > 0) {
        // Same-direction or value change at visible state — add a quick pulse
        badge.classList.remove('bump');
        // force reflow so the animation re-triggers even if the class was just added/removed
        // eslint-disable-next-line no-unused-expressions
        void badge.offsetWidth;
        badge.classList.add('bump');
      }
    } else {
      // On the way out: let the CSS fade play, but leave the number in the DOM
      // so it doesn't visually "snap" to 0 before fading.
      cancelBadgeTween(badge);
    }

    const img = li.querySelector('img');
    img.alt = foodName(food.id);

    const tip = li.querySelector('.name-tip');
    tip.textContent = `${foodName(food.id)} · ${categoryName(food.category)}`;

    const unused = count > 0 && !neededFoods.has(food.id);
    li.classList.toggle('unused', unused);
    if (unused) li.dataset.unusedLabel = t('unusedTag');
  }
}

// ---------------- recipe wall (diff-based, reordered without remounting) ----------------
function sortedFilteredRecipes() {
  const foodsByCat = buildFoodsByCategory();
  // Precompute missing-slot counts once per recipe so the sort comparator is cheap.
  const info = state.recipes.map((r) => {
    const made = state.made.has(r.id);
    const missing = made ? 0 : countMissingSlots(r, state.inventory, foodsByCat);
    return { r, made, missing };
  });
  info.sort((a, b) => {
    // Primary: cookable (missing=0 & !made) → not made → made
    const rankA = a.made ? 2 : a.missing === 0 ? 0 : 1;
    const rankB = b.made ? 2 : b.missing === 0 ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    // Secondary (applies within "not made, not cookable"): fewer missing first
    if (rankA === 1 && a.missing !== b.missing) return a.missing - b.missing;
    // Tertiary: original in-game priority, then id for stability
    return a.r.priority - b.r.priority || a.r.id.localeCompare(b.r.id);
  });
  return info.map((x) => x.r);
}

function renderCards() {
  const wall = $('#recipe-wall');
  const filtered = sortedFilteredRecipes();
  const foodsByCat = buildFoodsByCategory();

  // If we previously showed the empty note, nuke it — it's not tracked in cardNodes.
  const note = wall.querySelector('.empty-note');
  if (note) note.remove();

  if (filtered.length === 0) {
    // Hide every card without removing (keeps the map warm for next render)
    for (const node of cardNodes.values()) node.remove();
    const emptyNote = document.createElement('div');
    emptyNote.className = 'empty-note';
    emptyNote.textContent = t('noRecipes');
    wall.appendChild(emptyNote);
    return;
  }

  const wanted = new Set(filtered.map((r) => r.id));

  // Remove stale (filtered-out) cards
  for (const [id, node] of cardNodes) {
    if (!wanted.has(id)) {
      node.remove();
      cardNodes.delete(id);
    }
  }

  // Create any missing cards, update all of them in place, then reorder by re-appending.
  // (Appending a node that's already in the DOM *moves* it without remounting → no animation replay.)
  for (const recipe of filtered) {
    let card = cardNodes.get(recipe.id);
    let isNew = false;
    if (!card) {
      card = createCard(recipe);
      cardNodes.set(recipe.id, card);
      isNew = true;
    }
    updateCard(card, recipe, foodsByCat, isNew);
    wall.appendChild(card); // reorder in-place
  }
}

function createCard(recipe) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = recipe.id;

  const photo = document.createElement('div');
  photo.className = 'photo';
  const img = document.createElement('img');
  img.src = `assets/cookings/${recipe.id}.png`;
  img.loading = 'lazy';
  photo.appendChild(img);
  card.appendChild(photo);

  const strip = document.createElement('div');
  strip.className = 'ingredients';
  for (const slot of recipe.ingredients) {
    strip.appendChild(createIngredientSlot(slot));
  }
  card.appendChild(strip);

  const cap = document.createElement('div');
  cap.className = 'caption';
  const name = document.createElement('span');
  name.className = 'caption-name';
  cap.appendChild(name);
  const toolTag = document.createElement('span');
  toolTag.className = 'tool-tag';
  cap.appendChild(toolTag);
  card.appendChild(cap);

  card.addEventListener('click', () => toggleMade(recipe.id));
  return card;
}

function updateCard(card, recipe, foodsByCat, isNew) {
  const made = state.made.has(recipe.id);
  const cookable = !made && canCook(recipe, state.inventory, foodsByCat);
  // Per-slot assignment of which unit of inventory is reserved for each slot.
  // This avoids highlighting both slots of a recipe that needs 2x food10 when
  // the player only owns 1x food10.
  const assignment = computeSlotFill(recipe, state.inventory, foodsByCat);

  card.classList.toggle('made', made);
  card.classList.toggle('makeable', !made && cookable);
  card.classList.toggle('locked', !made && !cookable);
  card.dataset.stamp = t('madeStamp');
  card.title = made ? t('markUnmade') : t('markMade');

  card.querySelector('.photo img').alt = cookingName(recipe.id);
  card.querySelector('.caption-name').textContent = cookingName(recipe.id);
  card.querySelector('.tool-tag').textContent = `${t('toolHeading')}: ${toolName(recipe.tool)}`;

  const slots = card.querySelectorAll('.ingredient');
  recipe.ingredients.forEach((slot, i) => {
    const el = slots[i];
    if (el) updateIngredientSlot(el, slot, assignment[i], foodsByCat);
  });

  if (isNew) {
    card.classList.add('enter');
    card.addEventListener(
      'animationend',
      () => card.classList.remove('enter'),
      { once: true }
    );
  }
}

function createIngredientSlot(slot) {
  const wrap = document.createElement('div');
  wrap.className = 'ingredient';
  if (!slot.startsWith('<')) {
    const img = document.createElement('img');
    img.src = `assets/ingredients/${slot}.png`;
    wrap.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.className = 'placeholder';
    wrap.appendChild(span);
  }
  return wrap;
}

function updateIngredientSlot(wrap, slot, assigned, foodsByCat) {
  // `assigned` is the food id the backtracker reserved for THIS slot, or null if
  // the player's inventory can't cover it. That's what drives the green "have" halo.
  const have = assigned !== null && assigned !== undefined;
  if (!slot.startsWith('<')) {
    wrap.title = foodName(slot);
    const img = wrap.querySelector('img');
    if (img) img.alt = foodName(slot);
    wrap.classList.toggle('have', have);
  } else {
    const tags = slot.split('|').map((s) => s.replace(/[<>]/g, ''));
    const labelParts = tags.map((tag) => (tag === 'any' ? t('anyIngredient') : categoryName(tag)));
    const label = labelParts.join(' / ');
    const span = wrap.querySelector('.placeholder');
    if (span) {
      // When multiple tags, show initials to fit the tiny slot; otherwise full label.
      span.textContent = tags.length === 1 ? label : labelParts.map((s) => s[0] || '?').join('/');
    }
    // If we assigned a concrete food to this placeholder slot, surface it in the tooltip.
    wrap.title = have ? `${label} → ${foodName(assigned)}` : label;
    wrap.classList.toggle('have', have);
  }
}

function toggleMade(id) {
  if (state.made.has(id)) state.made.delete(id);
  else state.made.add(id);
  saveLocal();
  // Only the stuff that depends on "made" needs to change — no full remount:
  updateStats();
  renderInventory();
  renderCards();
}

function onInventoryChange() {
  updateStats();
  renderInventory();
  renderCards();
}

function renderAll() {
  applyLang();
  updateStats();
  renderInventory();
  renderCards();
}

// ---------------- events ----------------
function setupLangSelect() {
  const root = $('#lang-select');
  if (!root) return;
  const current = root.querySelector('.select-current');
  const menu = root.querySelector('.select-menu');
  const opts = [...menu.querySelectorAll('.select-opt')];

  const paint = () => {
    for (const opt of opts) {
      const active = opt.dataset.value === state.lang;
      opt.classList.toggle('active', active);
      if (active) current.textContent = opt.textContent;
    }
  };

  const open = () => root.setAttribute('aria-expanded', 'true');
  const close = () => root.setAttribute('aria-expanded', 'false');

  root.addEventListener('click', (ev) => {
    const opt = ev.target.closest('.select-opt');
    if (opt) {
      const value = opt.dataset.value;
      if (value && value !== state.lang) {
        state.lang = value;
        saveLocal();
        renderAll();
      }
      close();
      return;
    }
    if (root.getAttribute('aria-expanded') === 'true') close();
    else open();
  });

  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      if (root.getAttribute('aria-expanded') === 'true') close();
      else open();
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const idx = opts.findIndex((o) => o.dataset.value === state.lang);
      const next = opts[(idx + (ev.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length];
      state.lang = next.dataset.value;
      saveLocal();
      renderAll();
    }
  });

  document.addEventListener('click', (ev) => {
    if (!root.contains(ev.target)) close();
  });

  paint();
  // Expose a refresher so renderAll() can update the current-label when state.lang changes.
  root._repaint = paint;
}

function attachEvents() {
  setupLangSelect();
  setupImportModal();

  $('#save-file').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) {
      closeImportModal();
      return;
    }
    const text = await file.text();
    importSaveText(text);
    ev.target.value = '';
    closeImportModal();
  });
  // Modern browsers fire 'cancel' when the user dismisses the file dialog without
  // picking anything. Older browsers are handled by the window-focus fallback below.
  $('#save-file').addEventListener('cancel', () => closeImportModal());

  $('#clear-save').addEventListener('click', () => {
    state.inventory = Object.create(null);
    state.made = new Set();
    saveLocal();
    $('#clear-save').hidden = true;
    renderAll();
  });
}

// Exposed so the file input handler (outside the modal closure) can dismiss the modal.
let closeImportModal = () => {};

// Intercept the "import save" button: show a modal prompting the user to copy
// the save-file path first, then only open the native file picker on confirmation.
// The modal stays visible while the OS file dialog is up — it is closed only after
// the dialog either returns a file (via 'change') or is dismissed (via 'cancel' /
// the window-focus fallback).
function setupImportModal() {
  const modal = $('#import-modal');
  const trigger = $('#open-import');
  const copyBtn = $('#copy-path');
  const cancelBtn = $('#cancel-import');
  const confirm = $('#confirm-import');
  const pathEl = $('#save-path');
  const fileInput = $('#save-file');

  let lastFocus = null;
  let pickerOpen = false;         // true while we're waiting for the OS dialog to resolve
  let focusFallbackTimer = null;

  const openModal = () => {
    lastFocus = document.activeElement;
    modal.classList.remove('closing');
    modal.hidden = false;
    copyBtn.classList.remove('copied');
    copyBtn.textContent = t('copyPath');
    setTimeout(() => confirm.focus(), 0);
    document.addEventListener('keydown', onKey);
  };
  let closeTimer = null;
  const doClose = () => {
    if (modal.hidden) return;
    clearTimeout(closeTimer);
    // Play the leaving animation (see .modal.closing in style.css), then
    // actually hide once it finishes so the next open starts from scratch.
    modal.classList.add('closing');
    pickerOpen = false;
    clearTimeout(focusFallbackTimer);
    document.removeEventListener('keydown', onKey);
    lastFocus?.focus?.();
    closeTimer = setTimeout(() => {
      modal.hidden = true;
      modal.classList.remove('closing');
    }, 240); // matches modal-shrink/fade-out duration
  };
  closeImportModal = doClose;

  const onKey = (ev) => {
    // While the OS file dialog is up the browser owns the keyboard, so Escape only
    // closes the modal when the user is actually interacting with it.
    if (ev.key === 'Escape' && !pickerOpen) doClose();
  };

  trigger.addEventListener('click', openModal);
  cancelBtn.addEventListener('click', doClose);
  modal.querySelector('.modal-backdrop').addEventListener('click', () => {
    if (!pickerOpen) doClose();
  });

  confirm.addEventListener('click', () => {
    // Keep the modal open so the user can re-copy the path if needed.
    pickerOpen = true;
    fileInput.click();

    // Fallback for browsers that don't fire the 'cancel' event:
    // when the window regains focus after the dialog closes, give 'change'
    // a short grace period to fire first, then close if nothing happened.
    const onFocusBack = () => {
      clearTimeout(focusFallbackTimer);
      focusFallbackTimer = setTimeout(() => {
        if (pickerOpen) doClose();
      }, 400);
      window.removeEventListener('focus', onFocusBack);
    };
    window.addEventListener('focus', onFocusBack);
  });

  copyBtn.addEventListener('click', async () => {
    const text = pathEl.textContent.trim();
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Fallback for non-secure contexts: old-school execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    if (ok) {
      copyBtn.classList.add('copied');
      copyBtn.textContent = t('copied');
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.textContent = t('copyPath');
      }, 1600);
    } else {
      showToast('Clipboard blocked');
    }
  });
}

// ---------------- init ----------------
async function init() {
  const [recipesRes, i18nRes] = await Promise.all([
    fetch('data/recipes.json').then((r) => r.json()),
    fetch('data/i18n.json').then((r) => r.json()),
  ]);
  state.recipes = recipesRes.recipes;
  state.foods = recipesRes.foods;
  state.tools = recipesRes.tools;
  state.i18n = i18nRes;

  // Default language follows the browser, then localStorage overrides it if present.
  state.lang = detectBrowserLang();
  loadLocal();

  if (state.made.size || Object.keys(state.inventory).length) {
    $('#clear-save').hidden = false;
  }

  attachEvents();
  renderAll();
}

init().catch((err) => {
  console.error(err);
  showToast('Failed to load data: ' + err.message);
});
